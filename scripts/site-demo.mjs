#!/usr/bin/env node
// Builds site/demo/index.html, the interactive demo on the website: `buckets inspect --export html` run on the large
// generated project of scripts/stress-project.mjs (about 300 buckets, a nested project, a link, violations, lock
// differences and three approvals in git for the timeline).
//
//   node scripts/site-demo.mjs [--poster]
//
// The script builds cli/dist when a source file is newer than it, generates the project in examples/.tmp/site-demo/
// (inside the repository, so `typescript` resolves), exports the page into site/demo/index.html and deletes the
// project. The Pages workflow runs it before it uploads site/, so site/demo/ is not committed.
//
// --poster also takes a WebP screenshot of the demo with a headless Chrome or Edge ($CHROME_PATH, or the usual install
// locations) into site/img/inspect-demo.webp, the picture the landing page shows before the demo loads. That file is
// committed: run with --poster after a change to the look of the inspect page.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...parts) => path.join(repo, ...parts);
const work = rel('examples', '.tmp', 'site-demo');
const out = rel('site', 'demo', 'index.html');
const poster = rel('site', 'img', 'inspect-demo.webp');
const POSTER = { width: 1280, height: 800 };

function newestMtime(dir) {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

function ensureCliBuilt() {
  const dist = rel('cli', 'dist', 'index.js');
  const sources = Math.max(newestMtime(rel('cli', 'src')), newestMtime(rel('adapters', 'ts', 'src')));
  if (existsSync(dist) && existsSync(rel('cli', 'dist', 'inspect-static.js')) && statSync(dist).mtimeMs >= sources) return;
  console.log('cli/dist is missing or older than the sources, building it');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', 'cli'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
}

/** A Chrome or Edge for the poster: $CHROME_PATH, or the usual install locations. */
function findChrome() {
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  const candidates = {
    win32: [
      `${process.env.PROGRAMFILES}/Google/Chrome/Application/chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}/Google/Chrome/Application/chrome.exe`,
      `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}/Microsoft/Edge/Application/msedge.exe`,
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] ?? [];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A WebP screenshot of a page, with headless Chrome over the DevTools protocol and reduced motion. */
async function screenshot(chromePath, url) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(path.join(tmpdir(), 'site-demo-chrome-'));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  try {
    let page;
    for (let i = 0; i < 75 && !page; i++) {
      await sleep(200);
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      } catch {
        // Chrome is still starting.
      }
    }
    if (!page) throw new Error(`${chromePath} did not open its DevTools port`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: POSTER.width, height: POSTER.height, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.navigate', { url });
    await sleep(3000);
    const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 82 });
    ws.close();
    return Buffer.from(shot.data, 'base64');
  } finally {
    chrome.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Chrome may hold a file a little longer; the folder is in the system temp folder.
    }
  }
}

ensureCliBuilt();
try {
  execFileSync(process.execPath, [rel('scripts', 'stress-project.mjs'), work, '--git'], { cwd: repo, stdio: 'inherit' });
  mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(process.execPath, [rel('cli', 'dist', 'index.js'), 'inspect', '--export', 'html', '--out', out], {
    cwd: path.join(work, 'big-shop'),
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1', SLOPBUCKETS_NO_UPDATE_CHECK: '1' },
  });
  console.log(`site/demo/index.html: ${(statSync(out).size / 1024).toFixed(0)} KB`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (process.argv.includes('--poster')) {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('No Chrome or Edge found (set CHROME_PATH), so site/img/inspect-demo.webp stays as it is.');
  } else {
    writeFileSync(poster, await screenshot(chromePath, pathToFileURL(out).href));
    console.log(`site/img/inspect-demo.webp: ${(statSync(poster).size / 1024).toFixed(0)} KB`);
  }
}

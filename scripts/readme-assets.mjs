#!/usr/bin/env node
// Builds the images of the README, the inspect guide and the landing page from the real CLI:
//
//   .github/readme/hero.svg           the website hero (block-letter banner, slop bucket, tagline) inside a CRT monitor
//   .github/readme/check-fail.svg     `buckets check` after the hook sequence below, exit code 1
//   .github/readme/hook-warning.svg   the pending list of the third edit of a hook session, with [NEW], [OLD] and [RESOLVED]
//   .github/readme/inspect.svg        the inspect page of the shop project, dark scheme, inside a CRT monitor
//   docs/public/img/inspect-*.webp    the five screenshots of docs/guide/inspect.md, light scheme
//   site/img/inspect-map.webp         the screenshot of the Inspect section of the landing page, dark scheme
//
// The hero reads the banner and the bucket from site/index.html, so it follows the website.
//
// The terminal images come from the real CLI. The script builds cli/dist when a source file is newer than it, writes
// the README example project (app, billing, log and payments, the same config the landing page shows) into
// examples/.tmp/readme-<name>/ (inside the repository, so `typescript` resolves), commits it to a git repository of
// its own, and runs `node cli/dist/index.js` there. hook-warning.svg is the `additionalContext` that
// `buckets hook pre-tool-use` returns for the third of these edits, each written to disk after its hook ran:
//
//   1. Write src/billing/refund.ts, which imports '../payments/client' (a private file of payments)
//   2. Write src/utils/date.ts, a file in no bucket
//   3. Write src/billing/refund.ts again: it imports '../payments' and '../log' (billing does not declare log)
//
// check-fail.svg is `buckets check` on the result, after a check of the project before the edits exits with 0. The CLI prints plain text, so the colors are the script's.
//
// The screenshots come from `buckets inspect` on the shop of scripts/stress-project.mjs (31 buckets, a nested project
// and a few violations), taken with a headless Chrome or Edge over the DevTools protocol with reduced motion. The
// files view is the shop after `buckets init` on a copy without buckets.config.json. Without Chrome (set
// CHROME_PATH to point at one), the script keeps the current screenshots.
//
// Run with `npm run readme:assets`. Pass `--print` to also print the captured output.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, generate } from './stress-project.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...parts) => path.join(repo, ...parts);
const outDir = rel('.github', 'readme');
const docsImg = rel('docs', 'public', 'img');
const tmpDir = rel('examples', '.tmp');
const PRINT = process.argv.includes('--print');

/* ------------------------------------------------------------------ palette (site/index.html :root) */

const C = {
  bg: '#020904',
  bg2: '#04140a',
  bg3: '#072011',
  phos: '#3dff74',
  phosHi: '#b8ffcc',
  text: '#b4f5c6',
  dim: '#6cbf86',
  faint: '#1f5532',
  line: '#2b8a4c',
  amber: '#ffc04d',
  red: '#ff6e61',
  cyan: '#8ef9ff',
  ink: '#021a0a',
};

const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => String(Math.round(v * 100) / 100);

/* ------------------------------------------------------------------ CLI build */

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
  if (existsSync(dist) && statSync(dist).mtimeMs >= sources) return;
  console.log('cli/dist is missing or older than the sources, building it');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', 'cli'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
}

/** The environment of every child, without GIT_* variables, which would point git at the outer repository. */
const childEnv = (dir) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  SLOPBUCKETS_NO_UPDATE_CHECK: '1',
  CLAUDE_PROJECT_DIR: dir,
});

function cli(dir, args, input) {
  const run = spawnSync(process.execPath, [rel('cli', 'dist', 'index.js'), ...args], { cwd: dir, encoding: 'utf8', input, env: childEnv(dir) });
  return { status: run.status, stdout: run.stdout.replace(/\r\n/g, '\n'), stderr: run.stderr };
}

function gitCommit(dir) {
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=readme', '-c', 'user.email=readme@example.invalid', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      env: childEnv(dir),
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'acme');
}

const write = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

/* ------------------------------------------------------------------ the README example project */

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** The config of the landing page shell (`cat buckets.config.json`). */
const CONFIG = {
  $schema: 'https://nicolascaous.github.io/slopbuckets/schema/v2.json',
  version: '2.0',
  ignore: ['**/*.test.ts', 'scripts/**'],
  projects: [],
  buckets: {
    app: { purpose: 'Starts the server and wires the routes', files: ['src/app/**'], public: null, dependsOn: { billing: 'Routes call the billing use cases', log: 'Logs errors thrown during startup' }, packages: {} },
    billing: { purpose: 'Issues and charges invoices', files: ['src/billing/**'], public: 'src/billing/index.ts', dependsOn: { payments: 'Charges go through the gateway' }, packages: {} },
    log: { purpose: 'Formats and writes application logs', files: ['src/log/**'], public: 'src/log/index.ts', dependsOn: {}, packages: {} },
    payments: { purpose: 'Talks to the payment gateway', files: ['src/payments/**'], public: 'src/payments/index.ts', dependsOn: {}, packages: {} },
  },
};

const FILES = {
  '.gitignore': 'node_modules/\n',
  'package.json': json({ name: 'acme', version: '1.0.0', private: true, type: 'module', devDependencies: { typescript: '^5.9.0' } }),
  'tsconfig.json': json({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', 'scripts'] }),
  'buckets.config.json': json(CONFIG),
  'src/app/main.ts': "import { createInvoice } from '../billing';\nimport { logError } from '../log';\n\ntry {\n  createInvoice('ada', 1200);\n} catch (error) {\n  logError(error);\n}\n",
  'src/billing/index.ts': "export { createInvoice } from './invoice';\n",
  'src/billing/invoice.ts': "// Creates an invoice and charges it.\nimport { charge } from '../payments';\n\nexport function createInvoice(customer: string, amountCents: number): string {\n  return charge(customer, amountCents);\n}\n",
  'src/billing/invoice.test.ts': "import { createInvoice } from './invoice';\n\ncreateInvoice('test', 1);\n",
  'src/log/index.ts': "export { logError } from './format';\n",
  'src/log/format.ts': 'export function logError(error: unknown): void {\n  console.error(`[error] ${String(error)}`);\n}\n',
  'src/payments/index.ts': "export { charge } from './client';\n",
  'src/payments/client.ts': 'export function charge(customer: string, amountCents: number): string {\n  return `charged ${customer} ${amountCents}`;\n}\n',
  'scripts/seed.ts': "import { createInvoice } from '../src/billing';\n\ncreateInvoice('seed', 100);\n",
};

/** The edits of the hook session, in order. Each one is written to disk after its hook ran. */
const SESSION = [
  ['src/billing/refund.ts', "import { charge } from '../payments/client';\n\nexport function refund(customer: string, amountCents: number): string {\n  return charge(customer, -amountCents);\n}\n"],
  ['src/utils/date.ts', 'export function today(): string {\n  return new Date().toISOString().slice(0, 10);\n}\n'],
  [
    'src/billing/refund.ts',
    "import { charge } from '../payments';\nimport { logError } from '../log';\n\nexport function refund(customer: string, amountCents: number): string {\n  try {\n    return charge(customer, -amountCents);\n  } catch (error) {\n    logError(error);\n    throw error;\n  }\n}\n",
  ],
];

function exampleProject(name) {
  const dir = path.join(tmpDir, `readme-${name}`, 'acme');
  rmSync(path.dirname(dir), { recursive: true, force: true });
  for (const [file, text] of Object.entries(FILES)) write(dir, file, text);
  gitCommit(dir);
  return dir;
}

function expectExit(what, run, status) {
  if (run.status !== status) throw new Error(`${what}: expected exit ${status}, got ${run.status}\n${run.stdout}\n${run.stderr}`);
}

/** `buckets check` on the clean project, which must pass, the hook session, and `buckets check` after it. */
function captureTerminals() {
  try {
    const clean = exampleProject('pass');
    const pass = cli(clean, ['check']);
    expectExit('check on the clean project', pass, 0);

    const dir = exampleProject('session');
    let context = '';
    SESSION.forEach(([file, content], i) => {
      const payload = {
        session_id: 'readme-session',
        transcript_path: '/home/dev/.claude/projects/acme/readme-session.jsonl',
        cwd: dir,
        permission_mode: 'default',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, file).replaceAll('\\', '/'), content },
        tool_use_id: `toolu_0${i + 1}`,
      };
      const run = cli(dir, ['hook', 'pre-tool-use'], JSON.stringify(payload));
      expectExit(`hook for edit ${i + 1}`, run, 0);
      context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
      if (PRINT) console.log(`\n--- hook, edit ${i + 1}\n${context}`);
      write(dir, file, content);
    });
    for (const section of ['[NEW]', '[OLD]', '[RESOLVED]']) {
      if (!context.split('\n').includes(section)) throw new Error(`the third hook call has no ${section} section; update SESSION in scripts/readme-assets.mjs\n${context}`);
    }
    const fail = cli(dir, ['check']);
    expectExit('check after the hook session', fail, 1);
    for (const run of [pass, fail]) assertScrubbed('buckets check', run.stdout);
    if (PRINT) console.log(`\n--- check, clean\n${pass.stdout}\n--- check, after the session\n${fail.stdout}`);
    return { fail: fail.stdout.trimEnd(), hook: context };
  } finally {
    for (const name of ['pass', 'session']) rmSync(path.join(tmpDir, `readme-${name}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Fails when `text` names the home folder or the repository folder, which the images must not show. */
function assertScrubbed(where, text) {
  const folders = [homedir(), repo].flatMap((p) => [p, p.replaceAll('\\', '/')]);
  const found = folders.find((p) => text.toLowerCase().includes(p.toLowerCase()));
  if (found !== undefined) throw new Error(`${where} shows the local folder ${found}`);
}

/* ------------------------------------------------------------------ terminal window SVG */

const T = { font: 14, charW: 8.4, lineH: 21, padX: 22, bar: 28, padTop: 20, padBottom: 22 };

const EXIT_COLOR = { 0: C.phos, 1: C.red, 3: C.amber };

/** The colors a color terminal would give a line of check or hook text, as runs of { text, color, bold }. */
function styleLine(line) {
  if (line.startsWith('# ')) return [{ text: line, color: C.dim }];
  if (line.startsWith('$ ')) return [{ text: '$', color: C.amber }, { text: ' ' }, { text: line.slice(2), color: C.phosHi, bold: true }];
  if (line === '$') return [{ text: '$', color: C.amber }];
  if (/^buckets check: no /.test(line) || line === '[RESOLVED]') return [{ text: line, color: C.phos, bold: true }];
  if (/^buckets( check)?: [1-9]/.test(line) || line === '[NEW]') return [{ text: line, color: C.amber, bold: true }];
  if (/^buckets: 0 /.test(line) || line === '[OLD]') return [{ text: line, color: C.dim }];
  const fix = /^( +fix (?:code|config):)(.*)$/.exec(line);
  if (fix) return [{ text: fix[1], color: C.cyan }, { text: fix[2] }];
  if (/^\S/.test(line)) return [{ text: line, color: C.phosHi }];
  return [{ text: line }];
}

/** One line of runs as <text>, each run placed at its column so the grid holds with any monospace font. */
function textLine(runs, y) {
  let col = 0;
  const spans = [];
  for (const run of runs) {
    // Split at spaces so that every word starts at its own column and runs of spaces never collapse.
    for (const part of run.text.split(/( +)/)) {
      if (part === '') continue;
      if (part.startsWith(' ')) {
        col += part.length;
        continue;
      }
      const fill = run.color ?? C.text;
      const attrs = [`x="${n(T.padX + col * T.charW)}"`];
      if (fill !== C.text) attrs.push(`fill="${fill}"`);
      if (run.bold) attrs.push('font-weight="700"');
      if (part.length > 1) attrs.push(`textLength="${n(part.length * T.charW)}"`);
      spans.push(`<tspan ${attrs.join(' ')}>${esc(part)}</tspan>`);
      col += [...part].length;
    }
  }
  return spans.length > 0 ? `<text y="${n(y)}">${spans.join('')}</text>` : '';
}

function terminalSvg({ lines: raw, exit, title, desc }, columns) {
  const lines = [...raw, '', '$'].map(styleLine);
  const W = Math.round(T.padX * 2 + columns * T.charW);
  const bodyTop = T.bar + T.padTop;
  const H = Math.round(bodyTop + lines.length * T.lineH + T.padBottom);
  const baseline = (i) => bodyTop + i * T.lineH + T.font;
  const text = lines.map((runs, i) => textLine(runs, baseline(i))).join('\n');
  const cursorX = T.padX + 2 * T.charW;
  const cursorY = baseline(lines.length - 1) - T.font + 2;
  const exitLabel = `exit ${exit}`;
  const badgeW = exitLabel.length * 7.2 + 16;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" xml:space="preserve">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>
.cur{animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.cur{animation:none}}
</style>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#08260f"/><stop offset=".45" stop-color="${C.bg}"/></linearGradient>
<radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect y="2" width="4" height="2" fill="#000" fill-opacity=".2"/></pattern>
<filter id="glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2.2" result="b"/><feComponentTransfer in="b" result="g"><feFuncA type="linear" slope=".55"/></feComponentTransfer><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<clipPath id="win"><rect width="${W}" height="${H}" rx="8"/></clipPath>
</defs>
<g clip-path="url(#win)">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${T.bar}" fill="${C.phos}"/>
<g font-family="${MONO}" font-size="12" font-weight="700" fill="${C.ink}">
<text x="14" y="18.5">tty1</text>
<text x="${n(W / 2)}" y="18.5" text-anchor="middle">~/acme</text>
<rect x="${n(W - 10 - badgeW)}" y="5" width="${n(badgeW)}" height="18" rx="2" fill="${C.ink}"/>
<text x="${n(W - 10 - badgeW / 2)}" y="18.5" text-anchor="middle" fill="${EXIT_COLOR[exit]}">${exitLabel}</text>
</g>
<g font-family="${MONO}" font-size="${T.font}" fill="${C.text}" filter="url(#glow)">
${text}
<rect class="cur" x="${n(cursorX)}" y="${n(cursorY)}" width="${n(T.charW)}" height="${T.font + 3}" fill="${C.phos}"/>
</g>
<rect y="${T.bar}" width="${W}" height="${H - T.bar}" fill="url(#scan)"/>
<rect width="${W}" height="${H}" fill="url(#vig)"/>
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="7.5" fill="none" stroke="${C.line}"/>
</svg>
`;
}

/* ------------------------------------------------------------------ screenshots of buckets inspect */

const SCREEN = { width: 1236, height: 820 };

/** A Chrome or Edge to take the screenshots with: $CHROME_PATH, or the usual install locations. */
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

/** Headless Chrome driven over the DevTools protocol, with Node's own fetch and WebSocket. */
async function openBrowser(chromePath) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(path.join(tmpdir(), 'readme-chrome-'));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 75 && !page; i++) {
    await sleep(200);
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      // Chrome is still starting.
    }
  }
  if (!page) {
    chrome.kill();
    throw new Error(`${chromePath} did not open its DevTools port`);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const k = ++id;
      pending.set(k, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: k, method, params }));
    });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  await send('Page.enable');
  await send('Runtime.enable');
  return {
    /**
     * Opens `url` in a viewport of width by height CSS pixels at `scale`, runs `act` (JavaScript) in the page, and
     * returns a WebP of the page, or of the box around the elements that `clip` (CSS selectors) names.
     */
    async shoot(url, { width, height, scale = 1, scheme = 'light', act = '', clip = null, quality = 82 }) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      // Reduced motion stops the transitions, so every run captures the same frame.
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: scheme }] });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url });
      await sleep(2500);
      if (act) {
        await evaluate(`(async () => { ${act} })()`);
        await sleep(1200);
      }
      await evaluate('document.activeElement && document.activeElement.blur()');
      let box;
      if (clip) {
        box = await evaluate(`(() => {
          const rects = ${JSON.stringify(clip)}.map((s) => document.querySelector(s).getBoundingClientRect());
          const x = Math.min(...rects.map((r) => r.left)), y = Math.min(...rects.map((r) => r.top));
          return { x, y, width: Math.max(...rects.map((r) => r.right)) - x, height: Math.max(...rects.map((r) => r.bottom)) - y, scale: 1 };
        })()`);
      }
      const text = await evaluate('document.body.innerText');
      const shot = await send('Page.captureScreenshot', { format: 'webp', quality, ...(box ? { clip: box } : {}) });
      return { image: Buffer.from(shot.data, 'base64'), text, size: box ? [Math.round(box.width), Math.round(box.height)] : [width, height] };
    },
    errors,
    async close() {
      ws.close();
      chrome.kill();
      await sleep(500);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Chrome may hold a file a little longer; the folder is in the system temp folder.
      }
    },
  };
}

/** Starts `buckets inspect` in `dir` and resolves with the child and the 127.0.0.1 URL it prints. */
function startInspect(dir) {
  const child = spawn(process.execPath, [rel('cli', 'dist', 'index.js'), 'inspect'], { cwd: dir, env: childEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`buckets inspect printed no URL in 60 seconds\n${output}`)), 60_000);
    const fail = (error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const read = (chunk) => {
      output += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(output)?.[0];
      if (url) {
        clearTimeout(timer);
        resolve({ child, url });
      }
    };
    child.stdout.setEncoding('utf8').on('data', read);
    child.stderr.setEncoding('utf8').on('data', read);
    child.on('exit', (code) => fail(new Error(`buckets inspect exited with ${code} before it printed a URL\n${output}`)));
  });
}

/** Picks an option of a <select> of the inspect page and tells the page, as a click would. */
const pick = (id, value) => `const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true }));`;

/** The shots of the shop: [file, hash, options]. The docs ones use the light scheme at twice the pixel density. */
const DOCS = { width: 1200, height: 760, scale: 2, scheme: 'light' };
const SHOP_SHOTS = [
  ['readme', '#/graph/bucket/payments?depth=1', { ...SCREEN, scheme: 'dark', quality: 90 }],
  ['site', '#/graph/bucket/payments?depth=1', { width: 1302, height: 840, scheme: 'dark' }],
  ['inspect-page', '#/graph/bucket/payments?depth=1', { ...DOCS, scale: 1.5 }],
  ['inspect-graph-focus', '#/graph/bucket/reviews?depth=2&pair=http,catalog', { ...DOCS, clip: ['#main'] }],
  ['inspect-matrix', '#/matrix/edge/http/reviews', { ...DOCS, clip: ['#main', '#detail'] }],
  ['inspect-pending', '#/pending', { ...DOCS, clip: ['#main'], act: pick('pending-by', 'rule') }],
];

/** The shop of scripts/stress-project.mjs, and a copy right after `buckets init`. */
function shopProjects() {
  const base = path.join(tmpDir, 'readme-shop');
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const shop = generate({ ...PRESETS.shop, out: path.join(base, 'big-shop') }).root;
  const fresh = generate({ ...PRESETS.shop, out: path.join(base, 'fresh', 'big-shop') }).root;
  rmSync(path.join(fresh, 'buckets.config.json'));
  const init = cli(fresh, ['init']);
  expectExit('buckets init on the shop', init, 0);
  return { base, shop, fresh };
}

async function captureScreens() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('No Chrome or Edge found (set CHROME_PATH), so the screenshots stay as they are.');
    return null;
  }
  const { base, shop, fresh } = shopProjects();
  const browser = await openBrowser(chromePath);
  const servers = [];
  const shots = {};
  try {
    const main = await startInspect(shop);
    servers.push(main.child);
    for (const [name, hash, options] of SHOP_SHOTS) shots[name] = await browser.shoot(main.url + hash, options);
    const after = await startInspect(fresh);
    servers.push(after.child);
    shots['inspect-files'] = await browser.shoot(after.url, { ...DOCS, clip: ['#main'], act: `location.hash = '#/files'; await new Promise((r) => setTimeout(r, 800)); ${pick('owner-filter', 'unowned')}` });
    for (const [name, shot] of Object.entries(shots)) assertScrubbed(`the ${name} screenshot`, shot.text);
    if (browser.errors.length > 0) throw new Error(`the inspect page logged errors:\n${browser.errors.join('\n')}`);
    return shots;
  } finally {
    for (const child of servers) child.kill();
    await browser.close();
    await sleep(300);
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/* ------------------------------------------------------------------ hero SVG */

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Reads the block-letter banner and the bucket (with the class of every character) from site/index.html. */
function readSiteArt() {
  const html = readFileSync(rel('site', 'index.html'), 'utf8');
  const banner = /<pre class="figlet figlet-wide"[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1];
  const bucket = /<pre class="bucket"[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1];
  if (!banner || !bucket) throw new Error('site/index.html no longer has the figlet banner or the bucket <pre>');
  const bucketRows = bucket.split('\n').map((line) => {
    const cells = [];
    const re = /<span class="([a-z]+)">([^<]*)<\/span>|([^<]+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const cls = m[1] ?? null;
      for (const ch of decodeEntities(m[2] ?? m[3])) cells.push({ ch, cls: ch === ' ' ? null : cls });
    }
    return cells;
  });
  return { banner: decodeEntities(banner).split('\n'), bucket: bucketRows };
}

/** 5x7 pixel letters for the tagline, drawn as shapes because an SVG inside <img> cannot load a web font. */
const PIXEL = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
};

/** Path data for a line of pixel text: one rectangle per horizontal run of lit pixels. */
function pixelText(text, x0, y0, p) {
  let d = '';
  [...text.toUpperCase()].forEach((ch, i) => {
    const glyph = PIXEL[ch];
    if (ch === ' ') return;
    if (!glyph) throw new Error(`no pixel glyph for ${ch}`);
    glyph.forEach((row, r) => {
      for (const m of row.matchAll(/#+/g)) {
        d += `M${n(x0 + (i * 6 + m.index) * p)} ${n(y0 + r * p)}h${n(m[0].length * p)}v${n(p)}h${n(-m[0].length * p)}z`;
      }
    });
  });
  return d;
}
const pixelWidth = (text, p) => (text.length * 6 - 1) * p;

/**
 * Path data for the double-line box-drawing characters of the banner (the "shadow" of the letters), as strokes
 * through the cell at (x, y) with size w by h.
 */
function boxChar(ch, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const g = Math.min(w, h) * 0.22;
  const L = x;
  const R = x + w;
  const T0 = y;
  const B = y + h;
  const seg = (...pts) => `M${pts.map(([a, b]) => `${n(a)} ${n(b)}`).join('L')}`;
  switch (ch) {
    case '═':
      return seg([L, cy - g], [R, cy - g]) + seg([L, cy + g], [R, cy + g]);
    case '║':
      return seg([cx - g, T0], [cx - g, B]) + seg([cx + g, T0], [cx + g, B]);
    case '╗':
      return seg([L, cy - g], [cx + g, cy - g], [cx + g, B]) + seg([L, cy + g], [cx - g, cy + g], [cx - g, B]);
    case '╔':
      return seg([R, cy - g], [cx - g, cy - g], [cx - g, B]) + seg([R, cy + g], [cx + g, cy + g], [cx + g, B]);
    case '╝':
      return seg([L, cy + g], [cx + g, cy + g], [cx + g, T0]) + seg([L, cy - g], [cx - g, cy - g], [cx - g, T0]);
    case '╚':
      return seg([R, cy + g], [cx - g, cy + g], [cx - g, T0]) + seg([R, cy - g], [cx + g, cy - g], [cx + g, T0]);
    default:
      return '';
  }
}

/** The block-letter banner: full blocks as filled runs, box-drawing characters as thin double lines. */
function bannerArt(rows, x0, y0, w, h) {
  let fill = '';
  let stroke = '';
  rows.forEach((row, r) => {
    const chars = [...row];
    let c = 0;
    while (c < chars.length) {
      if (chars[c] === '█') {
        let end = c;
        while (chars[end] === '█') end++;
        fill += `M${n(x0 + c * w)} ${n(y0 + r * h)}h${n((end - c) * w)}v${n(h)}h${n(-(end - c) * w)}z`;
        c = end;
      } else {
        stroke += boxChar(chars[c], x0 + c * w, y0 + r * h, w, h);
        c++;
      }
    }
  });
  return { fill, stroke };
}

const BUCKET_COLORS = { as: C.phos, ah: '#a7d8b4', ar: '#8fb79a', am: '#3d6b4b', aband: '#9fd1ad' };

/** The ASCII bucket from the site, drawn with shapes: block glyphs as rectangles, the handle as strokes, bubbles as rings. */
function bucketArt(rows, x0, y0, w, h) {
  const fills = {};
  const add = (key, d) => (fills[key] = (fills[key] ?? '') + d);
  let handle = '';
  const bubbles = [];
  const rect = (x, y, rw, rh) => `M${n(x)} ${n(y)}h${n(rw)}v${n(rh)}h${n(-rw)}z`;
  rows.forEach((cells, r) => {
    cells.forEach(({ ch, cls }, c) => {
      if (!cls) return;
      const x = x0 + c * w;
      const y = y0 + r * h;
      const cx = x + w / 2;
      if (cls === 'ab') {
        bubbles.push({ cx, cy: y + h * 0.6, r: ch === 'O' ? w * 0.36 : w * 0.26 });
        return;
      }
      if (cls === 'ah') {
        const line = (x1, y1, x2, y2) => `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`;
        if (ch === '_') handle += line(x, y + h * 0.92, x + w, y + h * 0.92);
        else if (ch === '-') handle += line(x + w * 0.15, y + h * 0.55, x + w * 0.85, y + h * 0.55);
        else if (ch === '.') handle += line(cx, y + h * 0.82, cx, y + h * 0.9);
        else if (ch === "'") handle += line(cx, y + h * 0.12, cx, y + h * 0.36);
        else if (ch === '"') handle += line(cx - w * 0.2, y + h * 0.12, cx - w * 0.2, y + h * 0.36) + line(cx + w * 0.2, y + h * 0.12, cx + w * 0.2, y + h * 0.36);
        else if (ch === '/') handle += line(x + w * 0.85, y, x + w * 0.15, y + h);
        else if (ch === '\\') handle += line(x + w * 0.15, y, x + w * 0.85, y + h);
        return;
      }
      // Shades become texture: ▓ dense, ▒ medium, solid for the other block glyphs.
      const shade = ch === '▓' ? 'dense' : ch === '▒' ? 'medium' : 'solid';
      const key = `${cls}|${shade}`;
      if (ch === '▄') add(key, rect(x, y + h / 2, w, h / 2));
      else if (ch === '▀') add(key, rect(x, y, w, h / 2));
      else if (ch === '▐') add(key, rect(x + w / 2, y, w / 2, h));
      else if (ch === '▌') add(key, rect(x, y, w / 2, h));
      else add(key, rect(x, y, w, h));
    });
  });
  return { fills, handle, bubbles };
}

function heroSvg() {
  const art = readSiteArt();
  const W = 1280;
  const bezel = 22;
  const chin = 40;
  const sx = bezel;
  const sy = bezel;
  const sw = W - bezel * 2;
  const bar = 26;
  const pad = 44;
  const cx0 = sx + pad;
  const contentW = sw - pad * 2;

  // Banner: 91 columns, cells about 0.6 as wide as they are tall, like the site's block font.
  const cols = Math.max(...art.banner.map((r) => [...r].length));
  const bw = Math.floor((contentW / cols) * 10) / 10;
  const bh = Math.round(bw * 1.68 * 10) / 10;
  const bannerX = cx0 + (contentW - cols * bw) / 2;
  const bannerY = sy + bar + 34;
  const banner = bannerArt(art.banner, bannerX, bannerY, bw, bh);
  const bannerBottom = bannerY + art.banner.length * bh;

  // Bucket on the left, tagline on the right.
  const rowsTop = bannerBottom + 30;
  const kw = 9;
  const kh = 15.4;
  const bucketCols = Math.max(...art.bucket.map((r) => r.length));
  const bucketX = cx0 + 6;
  const bucket = bucketArt(art.bucket, bucketX, rowsTop, kw, kh);
  const bucketH = art.bucket.length * kh;

  const p = 5.6;
  const line1 = 'Let the AI write slop';
  const line2 = 'Keep it in buckets';
  const tx = bucketX + bucketCols * kw + 44;
  const kickerY = rowsTop + 40;
  const l1y = kickerY + 22;
  const l2box = { x: tx - 10, y: l1y + 7 * p + 18, w: pixelWidth(line2, p) + 20, h: 7 * p + 20 };
  const l2y = l2box.y + 10;
  const installY = l2box.y + l2box.h + 46;
  const contentBottom = Math.max(rowsTop + bucketH, installY + 10);
  const sh = contentBottom + 30 - sy;
  const H = sy + sh + chin;

  const l1 = pixelText(line1, tx, l1y, p);
  const l2 = pixelText(line2, tx, l2y, p);
  const install = '$ npm install -g slopbuckets';
  const installCharW = 9;
  const shades = { solid: 1, dense: 0.82, medium: 0.6 };

  const bucketPaths = Object.entries(bucket.fills)
    .map(([key, d]) => {
      const [cls, shade] = key.split('|');
      const glow = cls === 'as' ? ' filter="url(#glow)"' : '';
      const texture = shade === 'solid' ? '' : ` mask="url(#${shade})"`;
      return `<path d="${d}" fill="${BUCKET_COLORS[cls]}" fill-opacity="${shades[shade]}"${glow}${texture}/>`;
    })
    .join('\n');

  const bubbles = bucket.bubbles
    .map((b, i) => `<g class="bub b${i % 3}"><circle cx="${n(b.cx)}" cy="${n(b.cy)}" r="${n(b.r)}"/></g>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${n(H)}" width="${W}" height="${n(H)}" role="img" aria-labelledby="t d">
<title id="t">slopbuckets. Let the AI write slop. Keep it in buckets.</title>
<desc id="d">A green phosphor CRT monitor shows the SLOPBUCKETS block-letter banner, an ASCII bucket full of green slop with bubbles rising from it, and the tagline.</desc>
<style>
.bub{fill:none;stroke:${C.phosHi};stroke-width:1.6;transform-box:fill-box;transform-origin:center;animation:bubble 3.2s ease-in-out infinite}
.b1{animation-delay:-1.1s}.b2{animation-delay:-2s}
@keyframes bubble{0%,100%{transform:translateY(0);opacity:1}50%{transform:translateY(-6px);opacity:.6}}
.roll{animation:roll 9s linear infinite}
@keyframes roll{from{transform:translateY(0)}to{transform:translateY(${n(sh + 160)}px)}}
.cur{animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.bub,.roll,.cur{animation:none}.roll{display:none}}
</style>
<defs>
<linearGradient id="case" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b231d"/><stop offset=".5" stop-color="#101612"/><stop offset="1" stop-color="#090d0a"/></linearGradient>
<radialGradient id="screen" cx=".5" cy="0" r="1.1"><stop offset="0" stop-color="#0c3018"/><stop offset=".55" stop-color="${C.bg}"/></radialGradient>
<radialGradient id="vig" cx=".5" cy=".5" r=".72"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></radialGradient>
<linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.phos}" stop-opacity="0"/><stop offset=".5" stop-color="${C.phos}" stop-opacity=".06"/><stop offset="1" stop-color="${C.phos}" stop-opacity="0"/></linearGradient>
<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect y="2" width="4" height="2" fill="#000" fill-opacity=".24"/></pattern>
<pattern id="dither2" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#fff"/><rect width="1.5" height="1.5" fill="#000"/></pattern>
<pattern id="dither1" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="1.5" fill="#fff"/></pattern>
<mask id="dense" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${n(H)}"><rect width="${W}" height="${n(H)}" fill="url(#dither2)"/></mask>
<mask id="medium" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${n(H)}"><rect width="${W}" height="${n(H)}" fill="url(#dither1)"/></mask>
<filter id="glow" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="3.2" result="b"/><feComponentTransfer in="b" result="g"><feFuncA type="linear" slope=".8"/></feComponentTransfer><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<clipPath id="glass"><rect x="${sx}" y="${sy}" width="${sw}" height="${n(sh)}" rx="18"/></clipPath>
</defs>
<rect width="${W}" height="${n(H)}" rx="30" fill="url(#case)"/>
<rect x="1" y="1" width="${W - 2}" height="${n(H - 2)}" rx="29" fill="none" stroke="#2a352d" stroke-width="2"/>
<rect x="${sx - 5}" y="${sy - 5}" width="${sw + 10}" height="${n(sh + 10)}" rx="22" fill="#050806" stroke="#000" stroke-width="2"/>
<g clip-path="url(#glass)">
<rect x="${sx}" y="${sy}" width="${sw}" height="${n(sh)}" fill="url(#screen)"/>
<rect x="${sx}" y="${sy}" width="${sw}" height="${bar}" fill="${C.phos}"/>
<g font-family="${MONO}" font-size="12" font-weight="700" fill="${C.ink}">
<text x="${sx + 22}" y="${sy + 17.5}">tty0</text>
<text x="${n(sx + sw / 2)}" y="${sy + 17.5}" text-anchor="middle">slopbuckets</text>
<text x="${sx + sw - 22}" y="${sy + 17.5}" text-anchor="end">80x30</text>
</g>
<g fill="${C.phos}" filter="url(#glow)">
<path d="${banner.fill}"/>
<path d="${banner.stroke}" fill="none" stroke="${C.phos}" stroke-width="1.5" stroke-opacity=".85"/>
</g>
<g>
${bucketPaths}
<path d="${bucket.handle}" fill="none" stroke="${BUCKET_COLORS.ah}" stroke-width="2" stroke-linecap="round" filter="url(#soft)"/>
<g filter="url(#soft)">${bubbles}</g>
</g>
<g font-family="${MONO}" font-size="15">
<text x="${n(tx)}" y="${n(kickerY)}" fill="${C.dim}"><tspan fill="${C.amber}">$</tspan> cat motd</text>
</g>
<path d="${l1}" fill="#ff3d6e" fill-opacity=".28" transform="translate(-2 0)"/>
<path d="${l1}" fill="#3dd8ff" fill-opacity=".28" transform="translate(2 0)"/>
<path d="${l1}" fill="${C.phosHi}" filter="url(#glow)"/>
<rect x="${n(l2box.x)}" y="${n(l2box.y)}" width="${n(l2box.w)}" height="${n(l2box.h)}" fill="${C.phos}" filter="url(#glow)"/>
<path d="${l2}" fill="${C.ink}"/>
<g font-family="${MONO}" font-size="15" filter="url(#soft)">
<text y="${n(installY)}"><tspan x="${n(tx)}" fill="${C.amber}">$</tspan><tspan x="${n(tx + 2 * installCharW)}" fill="${C.phosHi}" textLength="${n((install.length - 2) * installCharW)}">${esc(install.slice(2))}</tspan></text>
<rect class="cur" x="${n(tx + (install.length + 1) * installCharW)}" y="${n(installY - 14)}" width="${installCharW}" height="18" fill="${C.phos}"/>
</g>
<rect class="roll" x="${sx}" y="${sy - 160}" width="${sw}" height="160" fill="url(#band)"/>
<rect x="${sx}" y="${sy}" width="${sw}" height="${n(sh)}" fill="url(#scan)"/>
<rect x="${sx}" y="${sy}" width="${sw}" height="${n(sh)}" fill="url(#vig)"/>
</g>
<rect x="${sx}" y="${sy}" width="${sw}" height="${n(sh)}" rx="18" fill="none" stroke="#000" stroke-opacity=".6" stroke-width="2"/>
<circle cx="${W - sx - 12}" cy="${n(sy + sh + chin / 2)}" r="4" fill="${C.phos}" filter="url(#soft)"/>
</svg>
`;
}

/* ------------------------------------------------------------------ screenshots in a CRT monitor */

/** The hero's monitor case around a screenshot, with optional SVG drawn over the screenshot. */
function monitorSvg({ title, desc, image, overlay = '' }) {
  const bezel = 22;
  const chin = 40;
  const sx = bezel;
  const sy = bezel;
  const sw = SCREEN.width;
  const sh = SCREEN.height;
  const W = sw + bezel * 2;
  const H = sy + sh + chin;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>
.roll{animation:roll 9s linear infinite}
@keyframes roll{from{transform:translateY(0)}to{transform:translateY(${sh + 160}px)}}
@media (prefers-reduced-motion:reduce){.roll{animation:none;display:none}}
</style>
<defs>
<linearGradient id="case" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b231d"/><stop offset=".5" stop-color="#101612"/><stop offset="1" stop-color="#090d0a"/></linearGradient>
<radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>
<linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.phos}" stop-opacity="0"/><stop offset=".5" stop-color="${C.phos}" stop-opacity=".05"/><stop offset="1" stop-color="${C.phos}" stop-opacity="0"/></linearGradient>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="14"/></filter>
<clipPath id="glass"><rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="18"/></clipPath>
</defs>
<rect width="${W}" height="${H}" rx="30" fill="url(#case)"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="29" fill="none" stroke="#2a352d" stroke-width="2"/>
<rect x="${sx - 5}" y="${sy - 5}" width="${sw + 10}" height="${sh + 10}" rx="22" fill="#050806" stroke="#000" stroke-width="2"/>
<g clip-path="url(#glass)">
<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="${C.bg}"/>
<image x="${sx}" y="${sy}" width="${sw}" height="${sh}" href="data:image/webp;base64,${image.toString('base64')}"/>
${overlay}
<rect class="roll" x="${sx}" y="${sy - 160}" width="${sw}" height="160" fill="url(#band)"/>
<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="url(#vig)"/>
</g>
<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="18" fill="none" stroke="#000" stroke-opacity=".6" stroke-width="2"/>
<circle cx="${W - sx - 12}" cy="${sy + sh + chin / 2}" r="4" fill="${C.phos}"/>
</svg>
`;
}

/* ------------------------------------------------------------------ main */

const DESCRIPTIONS = {
  fail: {
    title: 'buckets check fails with exit code 1',
    desc: 'After the agent session, buckets check lists 2 structure violations of the README example project in full: billing imports log without declaring it, in src/billing/refund.ts line 2, and src/utils/date.ts is in no bucket. Each item ends with a choose one fix line, then a fix code line and a fix config line. The exit code is 1.',
  },
  hook: {
    title: 'The pending list that the PreToolUse hook adds to the agent context',
    desc: 'The third edit of an agent session gets 2 pending items. Under [NEW], the undeclared dependency from billing to log in full, with both purposes, the choose one fix line and the fix code and fix config lines. Under [OLD], the one-line reminder that src/utils/date.ts is in no bucket. Under [RESOLVED], the private file import of payments that this edit fixed.',
  },
  inspect: {
    title: 'buckets inspect shows the bucket graph',
    desc: 'The inspect page of a shop project with 31 buckets, in a green CRT monitor. The left column lists the buckets with their file counts and pending badges. The center shows the dependency graph in focus mode on payments: checkout and returns above it, events, http-client, log and money below. The details panel on the right shows the purpose of payments, its files, its public file with each export and the buckets that use it, and its dependencies with their reasons.',
  },
};

function save(file, data) {
  writeFileSync(file, data);
  console.log(`wrote ${path.relative(repo, file).replaceAll('\\', '/')} (${(data.length / 1024).toFixed(1)} KB)`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  ensureCliBuilt();
  mkdirSync(tmpDir, { recursive: true });
  try {
    const out = captureTerminals();
    const terminals = [
      { name: 'fail', file: 'check-fail.svg', exit: 1, lines: ['# the same project after three edits by an agent', '$ buckets check', ...out.fail.split('\n')] },
      {
        name: 'hook',
        file: 'hook-warning.svg',
        exit: 0,
        lines: ['# third edit of the session: the agent rewrites src/billing/refund.ts', "# buckets hook pre-tool-use adds this to the agent's context:", '', ...out.hook.split('\n')],
      },
    ];
    const columns = Math.max(80, ...terminals.flatMap((t) => t.lines.map((l) => [...l].length + 1)));
    for (const t of terminals) save(path.join(outDir, t.file), terminalSvg({ ...t, ...DESCRIPTIONS[t.name] }, columns));
    save(path.join(outDir, 'hero.svg'), heroSvg());

    const shots = await captureScreens();
    if (shots) {
      save(path.join(outDir, 'inspect.svg'), monitorSvg({ ...DESCRIPTIONS.inspect, image: shots.readme.image }));
      save(rel('site', 'img', 'inspect-map.webp'), shots.site.image);
      mkdirSync(docsImg, { recursive: true });
      for (const [name, shot] of Object.entries(shots)) {
        if (!name.startsWith('inspect-')) continue;
        save(path.join(docsImg, `${name}.webp`), shot.image);
        console.log(`  ${name}.webp is ${shot.size[0]} by ${shot.size[1]} CSS pixels`);
      }
    }
  } finally {
    if (existsSync(tmpDir) && readdirSync(tmpDir).length === 0) rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();

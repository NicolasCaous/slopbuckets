#!/usr/bin/env node
// Builds the images that README.md shows, into .github/readme/:
//
//   hero.svg          the website hero (block-letter banner, slop bucket, tagline) inside a CRT monitor
//   check-fail.svg    `buckets check` with broken rules, exit code 1
//   check-lock.svg    `buckets check` with lock differences, exit code 2
//   check-pass.svg    `buckets check` on an approved project, exit code 0
//   inspect.svg       the map page of `buckets inspect` inside a CRT monitor
//   refresh-web.svg   the review page of `buckets refresh --web` inside a CRT monitor, with the confirmation window
//
// The hero reads the banner and the bucket from site/index.html, so it follows the website.
// The terminal images come from the real CLI. The script builds cli/dist when a source file is newer than it,
// copies examples/valid-readme/project to examples/.tmp/readme-<name>/ (inside the repository, so `typescript`
// resolves), gives the copy the alias @root-k3x9pm2a in place of @root (the shape of the unique alias that
// `buckets init` generates), writes a fresh lock with computeLock and writeLock from cli/src/api.ts, applies the edits of the
// scenario, runs `node cli/dist/index.js check` there and turns the colored output into SVG. A small preload
// tells the CLI that stdout is an 88-column terminal, so the output wraps and gets its marks the way a human
// sees it. The copies are deleted at the end.
//
// The two monitor images are screenshots of the real pages. The script builds examples/.tmp/readme-screens/acme
// (valid-readme with a nested project and the edits of the `lock` scenario), starts `buckets inspect` and
// `buckets refresh --web` there, and takes a WebP screenshot of each page with a headless Chrome or Edge over the
// DevTools protocol. The review server is stopped without a decision, so no confirmation window opens and no lock
// is written. The confirmation window in front of the review page is drawn from the real dialogRequest() text
// and the code of the review. Without Chrome (set CHROME_PATH to point at one), the script keeps the current
// inspect.svg and refresh-web.svg.
//
// Run with `npm run readme:assets`. Pass `--print` to also print the captured output.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...parts) => path.join(repo, ...parts);
const outDir = rel('.github', 'readme');
const tmpDir = rel('examples', '.tmp');
const COLUMNS = 88;
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

/* ------------------------------------------------------------------ CLI build and scenarios */

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

/**
 * Bundles cli/src/api.ts, the API the examples battery uses to write a fresh lock, into examples/.tmp/, together
 * with the review that `buckets refresh --web` shows and the text of its confirmation window.
 */
async function loadApi() {
  const { build } = await import('esbuild');
  const outfile = path.join(tmpDir, 'readme-api.mjs');
  await build({
    stdin: {
      contents: [
        "export * from './api.ts';",
        "export { evaluateTree } from './web/lock-review.ts';",
        "export { dialogRequest } from './web/refresh-app.ts';",
      ].join('\n'),
      resolveDir: rel('cli', 'src'),
      sourcefile: 'readme-entry.ts',
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['typescript'],
    // version.ts reads ../package.json next to its own file, so the bundle keeps the URL of cli/src.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(rel('cli', 'src', 'api.ts')).href) },
    logLevel: 'warning',
  });
  return import(pathToFileURL(outfile).href);
}

const TTY_PRELOAD = `// Written by scripts/readme-assets.mjs: makes the CLI format its output for a ${COLUMNS}-column terminal.
for (const stream of [process.stdout, process.stderr]) {
  Object.defineProperty(stream, 'isTTY', { value: true });
  Object.defineProperty(stream, 'columns', { value: ${COLUMNS} });
}
`;

const write = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const edit = (dir, file, from, to) => {
  const p = path.join(dir, file);
  const text = readFileSync(p, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} no longer contains ${JSON.stringify(from)}; update the scenario in scripts/readme-assets.mjs`);
  writeFileSync(p, text.replace(from, to));
};

/**
 * The alias the images show. examples/valid-readme/project uses @root, the alias of projects created before
 * `buckets init` generated a unique one. The copies get a fixed alias of the generated shape, so every run draws
 * the same images. The nested project of the screens gets its own.
 */
const ALIAS = '@root-k3x9pm2a';
const NESTED_ALIAS = '@root-p7vd4wqe';

/** Every file below `dir`, relative to it. */
function filesBelow(dir, prefix = '') {
  return readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? filesBelow(dir, rel) : [rel];
  });
}

/** Copies examples/valid-readme/project to `dir` and moves it from @root to ALIAS. */
function copyExample(dir) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(rel('examples', 'valid-readme', 'project'), dir, { recursive: true });
  const config = JSON.parse(readFileSync(path.join(dir, 'buckets.config.json'), 'utf8'));
  if (config.alias !== '@root') throw new Error(`examples/valid-readme/project uses the alias ${config.alias}; update copyExample in scripts/readme-assets.mjs`);
  write(dir, 'buckets.config.json', `${JSON.stringify({ ...config, alias: ALIAS }, null, 2)}\n`);
  const tsconfig = JSON.parse(readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'));
  const { '@root/*': target, ...paths } = tsconfig.compilerOptions.paths;
  tsconfig.compilerOptions.paths = { ...paths, [`${ALIAS}/*`]: target };
  write(dir, 'tsconfig.json', `${JSON.stringify(tsconfig, null, 2)}\n`);
  for (const file of filesBelow(dir, 'root')) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    if (text.includes("'@root/")) writeFileSync(path.join(dir, file), text.split("'@root/").join(`'${ALIAS}/`));
  }
}

/**
 * Each scenario starts from examples/valid-readme/project with a fresh lock (the state a human approved) and then
 * edits files the way an AI agent would.
 */
const SCENARIOS = [
  {
    name: 'fail',
    file: 'check-fail.svg',
    exit: 1,
    comment: '# the AI takes the logger straight from log/_ and adds a relative import',
    apply(dir) {
      const file = 'root/billing/invoices/_/create-invoice.ts';
      edit(dir, file, `from '${ALIAS}/billing/dmz/.parent/invoices'`, `from '${ALIAS}/log/_/logger'`);
      edit(dir, file, `from '${ALIAS}/billing/invoices/_/invoice'`, "from './invoice'");
    },
  },
  {
    name: 'lock',
    file: 'check-lock.svg',
    exit: 2,
    comment: '# the AI adds a parameter to createInvoice and gives payments the logger',
    apply(dir) {
      edit(dir, 'root/billing/invoices/_/create-invoice.ts', 'amountCents: number): Invoice', 'amountCents: number, currency = "USD"): Invoice');
      edit(dir, 'root/billing/invoices/_/create-invoice.ts', "logger.info('created invoice ' + invoice.id + ' for ' + customer);", "logger.info('created invoice ' + invoice.id + ' for ' + customer + ' in ' + currency);");
      write(dir, 'root/billing/dmz/.parent/payments.ts', `export { logger } from '${ALIAS}/dmz/log/billing';\n`);
      edit(dir, 'root/billing/payments/_/charge.ts', `import type { Invoice } from '${ALIAS}/billing/dmz/invoices/payments';`, `import { logger } from '${ALIAS}/billing/dmz/.parent/payments';\nimport type { Invoice } from '${ALIAS}/billing/dmz/invoices/payments';`);
      edit(dir, 'root/billing/payments/_/charge.ts', '  return { invoiceId', "  logger.info('charging ' + invoice.id);\n  return { invoiceId");
    },
  },
  {
    name: 'pass',
    file: 'check-pass.svg',
    exit: 0,
    comment: '# a human approved the state with buckets refresh',
    apply() {},
  },
];

async function captureScenarios(api) {
  const preload = path.join(tmpDir, 'readme-tty.mjs');
  writeFileSync(preload, TTY_PRELOAD);
  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      const dir = path.join(tmpDir, `readme-${scenario.name}`);
      copyExample(dir);
      await api.writeLock(dir, await api.computeLock(dir));
      scenario.apply(dir);
      const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, rel('cli', 'dist', 'index.js'), 'check'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: '', CLAUDE_PROJECT_DIR: dir },
      });
      if (run.status !== scenario.exit) {
        throw new Error(`readme-${scenario.name}: expected exit ${scenario.exit}, got ${run.status}\n${run.stdout}\n${run.stderr}`);
      }
      assertScrubbed(`the output of readme-${scenario.name}`, run.stdout);
      if (PRINT) console.log(`\n--- ${scenario.name} (exit ${run.status})\n${run.stdout}${run.stderr}`);
      results.push({ ...scenario, output: run.stdout.replace(/\r\n/g, '\n').replace(/\n+$/, '') });
    }
  } finally {
    for (const scenario of SCENARIOS) rmSync(path.join(tmpDir, `readme-${scenario.name}`), { recursive: true, force: true });
    rmSync(preload, { force: true });
  }
  return results;
}

/* ------------------------------------------------------------------ screens: buckets inspect and buckets refresh --web */

const SCREEN = { width: 1236, height: 820 };
const NESTED = 'root/billing/payments/_/gateway';

/**
 * The project the screens show: examples/valid-readme/project named acme, with a nested project in
 * root/billing/payments/_/gateway, a fresh lock for both, and the edits of the `lock` scenario on top. The folder
 * is called acme because the confirmation window names the project by its folder.
 */
async function screensProject(api) {
  const dir = path.join(tmpDir, 'readme-screens', 'acme');
  rmSync(path.dirname(dir), { recursive: true, force: true });
  copyExample(dir);
  const json = (file, value) => write(dir, file, `${JSON.stringify(value, null, 2)}\n`);
  const pkg = (name) => ({ name, version: '0.0.0', private: true, type: 'module', devDependencies: { typescript: '^5.9.0' } });
  const tsconfig = JSON.parse(readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'));
  json('package.json', pkg('acme'));
  // Every project has its own tsconfig.json, and the enclosing one leaves the nested project out, as a nested `buckets init` does.
  json('tsconfig.json', { ...tsconfig, exclude: [NESTED] });
  json(`${NESTED}/package.json`, pkg('payment-gateway'));
  json(`${NESTED}/buckets.config.json`, { adapter: 'ts', root: 'root', alias: NESTED_ALIAS, layout: { default: 'deny', allow: ['root/*/*'] } });
  json(`${NESTED}/tsconfig.json`, { ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, paths: { [`${NESTED_ALIAS}/*`]: ['root/*'] } } });
  write(dir, `${NESTED}/root/_/index.ts`, `import { send } from '${NESTED_ALIAS}/dmz/http/.self';\n\nexport const ready = send('ping');\n`);
  write(dir, `${NESTED}/root/http/_/send.ts`, 'export function send(body: string): number {\n  return body.length;\n}\n');
  write(dir, `${NESTED}/root/dmz/http/.self.ts`, `export { send } from '${NESTED_ALIAS}/http/_/send';\n`);
  await api.writeLock(path.join(dir, NESTED), await api.computeLock(path.join(dir, NESTED)));
  await api.writeLock(dir, await api.computeLock(dir));
  SCENARIOS.find((s) => s.name === 'lock').apply(dir);
  return dir;
}

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
  await send('Emulation.setDeviceMetricsOverride', { width: SCREEN.width, height: SCREEN.height, deviceScaleFactor: 1, mobile: false });
  // Reduced motion stops the typing and blinking effects, so every run captures the same frame.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  return {
    /** Opens the URL, replaces every `from` in the page text with `to`, and returns a WebP screenshot. */
    async shoot(url, replace) {
      await send('Page.navigate', { url });
      await sleep(2500);
      const expression = `(() => {
        const replace = ${JSON.stringify(replace)};
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const [from, to] of replace) if (node.nodeValue.includes(from)) node.nodeValue = node.nodeValue.split(from).join(to);
        }
        return document.body.innerText;
      })()`;
      const text = (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      await sleep(300);
      const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 90 });
      return { image: Buffer.from(shot.data, 'base64'), text };
    },
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

/** Starts `buckets <args>` in `dir` and resolves with the child and the 127.0.0.1 URL it prints. */
function startServer(dir, args) {
  const child = spawn(process.execPath, [rel('cli', 'dist', 'index.js'), ...args], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', SLOPBUCKETS_NO_UPDATE_CHECK: '1', CLAUDE_PROJECT_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`buckets ${args.join(' ')} printed no URL in 60 seconds\n${output}`)), 60_000);
    const fail = (error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const read = (chunk) => {
      output += chunk;
      const url = /^http:\/\/127\.0\.0\.1:\d+\/\S*$/m.exec(output)?.[0];
      if (url) {
        clearTimeout(timer);
        resolve({ child, url, output });
      }
    };
    child.stdout.setEncoding('utf8').on('data', read);
    child.stderr.setEncoding('utf8').on('data', read);
    child.on('exit', (code) => fail(new Error(`buckets ${args.join(' ')} exited with ${code} before it printed a URL\n${output}`)));
  });
}

/** Fails when `text` names the home folder or the repository folder, which the images must not show. */
function assertScrubbed(where, text) {
  const folders = [homedir(), repo].flatMap((p) => [p, p.replaceAll('\\', '/')]);
  const found = folders.find((p) => text.toLowerCase().includes(p.toLowerCase()));
  if (found !== undefined) throw new Error(`${where} shows the local folder ${found}; add it to the replacements in captureScreens`);
}

/**
 * Screenshots of `buckets inspect` and of the review page of `buckets refresh --web`, plus the text of the
 * confirmation window, or null when there is no Chrome. The review server is stopped without a decision, so the
 * confirmation window never opens and the lock of the copy is never written.
 */
async function captureScreens(api) {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('No Chrome or Edge found (set CHROME_PATH), so inspect.svg and refresh-web.svg keep their current screenshots.');
    return null;
  }
  const dir = await screensProject(api);
  // The pages show the absolute folder of the copy. The images show it as ~/acme, like the terminal title.
  const replace = [dir, dir.replaceAll('\\', '/')].map((from) => [from, '~/acme']);
  const browser = await openBrowser(chromePath);
  const servers = [];
  try {
    const inspect = await startServer(dir, ['inspect']);
    servers.push(inspect.child);
    const inspectShot = await browser.shoot(inspect.url, replace);
    inspect.child.kill();
    assertScrubbed('the inspect page', inspectShot.text);

    const [state] = await api.evaluateTree(api.defaultContext(), dir);
    if (state.state.kind !== 'review') throw new Error(`the screens project has nothing to approve (${state.state.kind})`);
    const { review } = state.state;
    const refresh = await startServer(dir, ['refresh', '--web']);
    servers.push(refresh.child);
    const refreshShot = await browser.shoot(refresh.url, replace);
    refresh.child.kill();
    if (!refreshShot.text.includes(review.code)) throw new Error(`the review page does not show the code ${review.code}`);
    assertScrubbed('the review page', refreshShot.text);
    const dialog = api.dialogRequest(review);
    for (const [from, to] of replace) dialog.message = dialog.message.split(from).join(to);
    assertScrubbed('the confirmation window', `${dialog.title}\n${dialog.message}`);
    if (PRINT) console.log(`\n--- refresh --web\n${refresh.output}\n--- confirmation window\n${dialog.title}\n${dialog.message}`);
    return { inspect: inspectShot.image, refresh: refreshShot.image, dialog, code: review.code };
  } finally {
    for (const child of servers) child.kill();
    await browser.close();
    await sleep(300);
    rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/* ------------------------------------------------------------------ ANSI to styled runs */

const BASIC = { 31: C.red, 32: C.phos, 33: C.amber, 36: C.cyan, 37: C.text, 92: C.phos, 97: C.phosHi };

/** Splits one line of SGR-colored text into runs of { text, color, bold, dim }. */
function parseAnsi(line) {
  const runs = [];
  let state = { color: null, bold: false, dim: false };
  // eslint-disable-next-line no-control-regex
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  const push = (text) => {
    if (text !== '') runs.push({ text, ...state });
  };
  while ((m = re.exec(line)) !== null) {
    push(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    state = { ...state };
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) state = { color: null, bold: false, dim: false };
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 22) state.bold = state.dim = false;
      else if (code === 39) state.color = null;
      else if (code === 38 && codes[i + 1] === 2) {
        const hex = `#${codes.slice(i + 2, i + 5).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        state.color = hex;
        i += 4;
      } else if (BASIC[code]) state.color = BASIC[code];
    }
  }
  push(line.slice(last));
  return runs;
}

/* ------------------------------------------------------------------ terminal window SVG */

const T = { font: 14, charW: 8.4, lineH: 21, padX: 22, bar: 28, padTop: 20, padBottom: 22 };

const EXIT_COLOR = { 0: C.phos, 1: C.red, 2: C.amber };

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
      const fill = run.dim ? C.dim : (run.color ?? C.text);
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

function terminalSvg({ output, exit, comment, title, desc }, columns) {
  const lines = [
    [{ text: comment, color: C.dim }],
    [{ text: '$', color: C.amber }, { text: ' ' }, { text: 'buckets check', color: C.phosHi, bold: true }],
    ...output.split('\n').map(parseAnsi),
    [],
    [{ text: '$', color: C.amber }],
  ];
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

const UI_FONT = `'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif`;

/** Splits text into lines of at most `max` characters, at spaces. */
function wrapWords(text, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * The confirmation window that `buckets refresh --web` opens, drawn as a plain light window of the operating
 * system: the real title and message, the code typed in the text box, and the Approve and Cancel buttons. Its
 * bottom right corner sits at (right, bottom).
 */
function dialogSvg({ title, message }, code, right, bottom) {
  const w = 580;
  const pad = 18;
  const bar = 32;
  const lineH = 17.5;
  const gap = 8;
  const rows = [];
  for (const raw of message.split('\n')) {
    if (raw.trim() === '') {
      rows.push(null);
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    wrapWords(raw.trim(), 84 - indent).forEach((text, i) => rows.push({ text, indent: indent + (i > 0 && indent > 0 ? 2 : 0) }));
  }
  const textH = rows.reduce((h, row) => h + (row ? lineH : gap), 0);
  const boxH = 32;
  const buttonH = 30;
  const h = bar + pad + textH + 14 + boxH + 18 + buttonH + pad;
  const x = right - w;
  const y = bottom - h;
  let ty = y + bar + pad;
  const text = rows
    .map((row) => {
      if (!row) {
        ty += gap;
        return '';
      }
      ty += lineH;
      return `<text x="${n(x + pad + row.indent * 3.4)}" y="${n(ty - 4.5)}">${esc(row.text)}</text>`;
    })
    .join('');
  const boxY = y + bar + pad + textH + 14;
  const buttonY = boxY + boxH + 18;
  const codeX = x + pad + 10;
  const codeW = code.length * 11;
  const cancelX = x + w - pad - 92;
  const approveX = cancelX - 8 - 92;
  return `<g>
<rect x="${n(x + 4)}" y="${n(y + 14)}" width="${w}" height="${n(h)}" rx="8" fill="#000" fill-opacity=".75" filter="url(#shadow)"/>
<rect x="${n(x)}" y="${n(y)}" width="${w}" height="${n(h)}" rx="8" fill="#f3f3f3" stroke="#6b6b6b"/>
<path d="M${n(x)} ${n(y + 8)}a8 8 0 0 1 8 -8h${w - 16}a8 8 0 0 1 8 8v${bar - 8}h${-w}z" fill="#ffffff"/>
<path d="M${n(x)} ${n(y + bar)}h${w}" stroke="#e1e1e1"/>
<g font-family="${UI_FONT}" font-size="12.5" fill="#1b1b1b">
<text x="${n(x + 14)}" y="${n(y + 20.5)}" font-size="12">${esc(title)}</text>
<path d="M${n(x + w - 26)} ${n(y + 11)}l10 10m0 -10l-10 10" stroke="#1b1b1b" stroke-width="1.2"/>
${text}
<rect x="${n(x + pad)}" y="${n(boxY)}" width="220" height="${boxH}" rx="4" fill="#ffffff" stroke="#8a8a8a"/>
<path d="M${n(x + pad + 1)} ${n(boxY + boxH - 1)}h218" stroke="#005fb8" stroke-width="2"/>
<text x="${n(codeX)}" y="${n(boxY + 22)}" font-family="Consolas, ui-monospace, Menlo, monospace" font-size="18" textLength="${codeW}">${esc(code)}</text>
<path d="M${n(codeX + codeW + 3)} ${n(boxY + 7)}v18" stroke="#1b1b1b" stroke-width="1.4"/>
<rect x="${n(approveX)}" y="${n(buttonY)}" width="92" height="${buttonH}" rx="4" fill="#005fb8"/>
<text x="${n(approveX + 46)}" y="${n(buttonY + 19.5)}" text-anchor="middle" fill="#ffffff">Approve</text>
<rect x="${n(cancelX)}" y="${n(buttonY)}" width="92" height="${buttonH}" rx="4" fill="#fbfbfb" stroke="#c9c9c9"/>
<text x="${n(cancelX + 46)}" y="${n(buttonY + 19.5)}" text-anchor="middle">Cancel</text>
</g>
</g>`;
}

/* ------------------------------------------------------------------ main */

const DESCRIPTIONS = {
  fail: {
    title: 'buckets check fails with exit code 1',
    desc: 'The AI imported the logger from root/log/_ and used a relative import. buckets check reports import-forbidden on line 1 and import-relative on line 2 of root/billing/invoices/_/create-invoice.ts, then a dmz-orphan chain for logger, and exits with code 1.',
  },
  lock: {
    title: 'buckets check reports lock differences with exit code 2',
    desc: 'The AI changed the signature of createInvoice and added the DMZ file root/billing/dmz/.parent/payments.ts. The rules pass, so buckets check lists the lock differences for a human to approve and exits with code 2.',
  },
  pass: {
    title: 'buckets check passes with exit code 0',
    desc: 'After a human approved the state, buckets check prints that all bucket rules pass and the state matches buckets.lock.json, and exits with code 0.',
  },
  inspect: {
    title: 'buckets inspect shows the map of the buckets',
    desc: 'The read-only inspect page in a green CRT monitor. The map draws every bucket of acme as a box: root, billing with invoices and payments, and log. billing is amber because its contracts differ from the lock, and payments holds the nested project payment-gateway. The side panel counts the buckets, contracts, symbols and violations and links to the differences to approve. Tabs lead to the matrix, trace, projects, approvals, timeline and impact views.',
  },
  refresh: (code) => ({
    title: 'buckets refresh --web asks for the confirmation code',
    desc: `The review page of buckets refresh --web in a green CRT monitor lists 2 contract changes of acme and shows the confirmation code ${code}. In front of it, the confirmation window of the operating system lists the same changes, and the human has typed ${code} before clicking Approve.`,
  }),
};

function save(file, svg) {
  writeFileSync(path.join(outDir, file), svg);
  console.log(`wrote .github/readme/${file} (${(svg.length / 1024).toFixed(1)} KB)`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  ensureCliBuilt();
  mkdirSync(tmpDir, { recursive: true });
  try {
    const api = await loadApi();
    const results = await captureScenarios(api);
    const widest = Math.max(...results.flatMap((r) => [r.comment, ...r.output.split('\n')].map((l) => [...l.replace(/\u001b\[[0-9;]*m/g, '')].length)));
    const columns = Math.max(80, widest + 1);
    for (const result of results) save(result.file, terminalSvg({ ...result, ...DESCRIPTIONS[result.name] }, columns));
    save('hero.svg', heroSvg());

    const screens = await captureScreens(api);
    if (screens) {
      save('inspect.svg', monitorSvg({ ...DESCRIPTIONS.inspect, image: screens.inspect }));
      const overlay = dialogSvg(screens.dialog, screens.code, 22 + SCREEN.width - 40, 22 + SCREEN.height - 92);
      save('refresh-web.svg', monitorSvg({ ...DESCRIPTIONS.refresh(screens.code), image: screens.refresh, overlay }));
    }
  } finally {
    rmSync(path.join(tmpDir, 'readme-api.mjs'), { force: true });
    if (existsSync(tmpDir) && readdirSync(tmpDir).length === 0) rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();

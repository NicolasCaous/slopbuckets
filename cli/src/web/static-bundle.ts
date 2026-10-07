// Builds the browser script of `buckets inspect --export html` from inspect-static-entry.ts with esbuild: the live
// renderers of the inspect pages, for the file to render every page itself. tsup runs it after the CLI build and
// writes dist/inspect-static.js next to dist/index.js; running from the source (the tests), export-html.ts builds it
// on the fly with the same options.
//
// The renderers share modules with the server, so the bundle reaches Node built-ins it never calls in the browser.
// Each one gets a small stand-in: a POSIX `path`, a SHA-256 for `crypto.createHash`, and functions that throw for the
// rest (file access in a renderer already falls back when a read fails).
import type * as Esbuild from 'esbuild';
import { MAP_CORE_RETURN } from '../inspect/map-svg.js';
import { MAP_CORE_JS } from './assets/map-core.js';

/** The file next to the built CLI. */
export const STATIC_BUNDLE_FILE = 'inspect-static.js';

const PATH_STUB = String.raw`
const norm = (p) => {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); }
    else out.push(part);
  }
  return (abs ? '/' : '') + out.join('/');
};
const fix = (p) => String(p).replace(/\\/g, '/');
export const sep = '/';
export const delimiter = ':';
export function normalize(p) { p = fix(p); const n = norm(p) || (p.startsWith('/') ? '/' : '.'); return p.endsWith('/') && n !== '/' ? n + '/' : n; }
export function join(...parts) { const j = parts.map(fix).filter((x) => x !== '').join('/'); return j === '' ? '.' : normalize(j); }
export function isAbsolute(p) { return fix(p).startsWith('/'); }
export function resolve(...parts) { let r = ''; for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) r = fix(parts[i]) + (r ? '/' + r : ''); return norm('/' + r) || '/'; }
export function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean), b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
export function dirname(p) { p = fix(p).replace(/\/+$/, ''); const i = p.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); }
export function basename(p, ext) { p = fix(p).replace(/\/+$/, ''); let b = p.slice(p.lastIndexOf('/') + 1); if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length); return b; }
export function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); }
const path = { sep, delimiter, normalize, join, isAbsolute, resolve, relative, dirname, basename, extname };
path.posix = path;
path.win32 = path;
export const posix = path;
export const win32 = path;
export default path;
`;

// SHA-256 of a UTF-8 string, enough for createHash('sha256').update(text).digest('hex').
const CRYPTO_STUB = String.raw`
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256hex(bytes) {
  const len = bytes.length, total = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error('Only sha256 is available in the browser.');
  let text = '';
  const hash = { update(chunk) { text += String(chunk); return hash; }, digest() { return sha256hex(new TextEncoder().encode(text)); } };
  return hash;
}
const missing = () => { throw new Error('Not available in the browser.'); };
export const randomBytes = missing, randomInt = missing, randomUUID = missing, timingSafeEqual = missing;
export default { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual };
`;

/** Names each stubbed module exports. Calling any of them throws. */
const THROWING: Record<string, string[]> = {
  fs: ['accessSync', 'appendFileSync', 'constants', 'copyFileSync', 'cpSync', 'linkSync', 'lstatSync', 'mkdirSync', 'mkdtempSync', 'readFile', 'readFileSync', 'readdirSync', 'realpathSync', 'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'symlinkSync', 'unlinkSync', 'watch', 'writeFileSync'],
  'fs/promises': ['lstat', 'readFile', 'rename', 'unlink', 'writeFile'],
  child_process: ['execFile', 'execFileSync', 'spawn', 'spawnSync'],
  http: ['createServer', 'request'],
  module: ['createRequire'],
  os: ['homedir', 'tmpdir', 'platform'],
  url: ['fileURLToPath', 'pathToFileURL'],
  'readline/promises': ['createInterface'],
};

function throwingModule(names: string[], extra = ''): string {
  return `const missing = () => { throw new Error('Not available in the browser.'); };\n${names.map((n) => `export const ${n} = missing;`).join('\n')}\n${extra}export default { ${names.join(', ')} };\n`;
}

function stubSource(name: string): string | null {
  if (name === 'path') return PATH_STUB;
  if (name === 'crypto') return CRYPTO_STUB;
  // existsSync answers false, so code that checks before it reads takes its fallback.
  if (name === 'fs') return throwingModule(THROWING.fs!, 'export const existsSync = () => false;\n').replace('export default { ', 'export default { existsSync, ');
  if (name === 'module') return throwingModule(THROWING.module!, 'export const builtinModules = [];\n').replace('export default { ', 'export default { builtinModules, ');
  const names = THROWING[name];
  return names ? throwingModule(names) : null;
}

const nodeStubs: Esbuild.Plugin = {
  name: 'node-stubs',
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path.slice('node:'.length), namespace: 'node-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => {
      const contents = stubSource(args.path);
      if (contents === null) return { errors: [{ text: `node:${args.path} has no browser stand-in in static-bundle.ts` }] };
      return { contents, loader: 'js' };
    });
  },
};

/** map-core-compiled.ts with the map core source as a function, so the page never evaluates text. */
const compiledMapCore: Esbuild.Plugin = {
  name: 'compiled-map-core',
  setup(build) {
    build.onLoad({ filter: /[\\/]map-core-compiled\.ts$/ }, () => ({
      contents: `export const compiledMapCore = function () {\n'use strict';\n${MAP_CORE_JS}\n${MAP_CORE_RETURN}\n};\n`,
      loader: 'js',
    }));
  },
};

/** The minified browser script, as text that is safe inside a `<script>` element. */
export async function buildStaticBundle(build: typeof Esbuild.build, entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    plugins: [nodeStubs, compiledMapCore],
  });
  return result.outputFiles[0]!.text.replace(/<\/script/gi, '<\\/script').trimEnd();
}

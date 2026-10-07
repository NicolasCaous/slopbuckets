#!/usr/bin/env node
// Builds a large generated project for `buckets inspect`: the demo on the website (scripts/site-demo.mjs) and
// measurements of the pages. Needs cli/dist (npm run build) and the repository's node_modules.
//
//   node scripts/stress-project.mjs [outDir] [--git] [--verify]
//
// outDir defaults to examples/.tmp/stress. It is deleted and created again, so pick a folder of your own. --verify
// also type checks big-shop with tsc.
//
// stress/big-shop      buckets down to level 3, about 300 buckets: root has 8 children, root/services has 80, the other level-1
//                      buckets have 10 to 18, and 12 level-2 buckets have 5 to 10 children. Every _/ has 3 files.
//                      About 600 DMZ contracts: child to parent (.self), parent to child (.self/<child>), siblings,
//                      chains up through .parent and chains down through dmz/.parent/<child>. Bucket ranks keep the
//                      graph acyclic, except for one deliberate cycle.
//                      A nested project in root/web/_/widgetkit and a link to shared-sdk in root/platform/<bucket>.
// stress/shared-sdk    the linked project, with one .external.ts
//
// The lock is approved with computeLock/writeLock from cli/src/api.ts, then the working tree gets violations (a cycle,
// two forbidden imports, two orphans) and lock differences (changed signatures, a new contract, a new bucket).
//
// With --git (or `git: true`), big-shop is a git repository with three approvals for the timeline: the buckets, then
// the nested project and the link, then a changed signature in two services. Git runs with -c user.name and
// -c user.email and fixed dates, so it needs no git config and every run makes the same history.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const withGit = args.includes('--git');
const verify = args.includes('--verify');
const cli = path.join(repo, 'cli', 'dist', 'index.js');
const tsc = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const base = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(repo, 'examples', '.tmp', 'stress'));
if (!existsSync(cli)) {
  console.error('cli/dist/index.js not found. Run "npm run build" first.');
  process.exit(2);
}
const shop = path.join(base, 'big-shop');
const sdk = path.join(base, 'shared-sdk');

// ---------------------------------------------------------------- helpers

async function loadApi() {
  const tmp = path.join(repo, 'examples', '.tmp');
  mkdirSync(tmp, { recursive: true });
  const { build } = createRequire(path.join(repo, 'package.json'))('esbuild');
  const outfile = path.join(tmp, `stress-api-${process.pid}.mjs`);
  await build({
    stdin: { contents: "export * from './api.ts';", resolveDir: path.join(repo, 'cli', 'src'), sourcefile: 'stress-entry.ts', loader: 'ts' },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['typescript'],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(repo, 'cli', 'src', 'api.ts')).href) },
    logLevel: 'warning',
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(outfile, { force: true });
  }
}

function write(dir, file, text) {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text.endsWith('\n') ? text : `${text}\n`);
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function buckets(cwd, ...args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SLOPBUCKETS_NO_UPDATE_CHECK: '1', CLAUDE_PROJECT_DIR: cwd } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function mustBuckets(cwd, ...args) {
  const r = buckets(cwd, ...args);
  if (r.code !== 0) throw new Error(`buckets ${args.join(' ')} in ${cwd} exited ${r.code}\n${r.out}\n${r.err}`);
  return r;
}
function typecheck(dir) {
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const tsconfig = (comment) => `{
  // ${comment}
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "types": ["node"]
  },
  "include": ["root"]
}
`;

/** Seeded random numbers, so every run builds the same project. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261004);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- the bucket tree

const SERVICES = (
  'accounts addresses alerts analytics archive assets audit avatars badges baskets bookings branches budgets bundles ' +
  'calendar campaigns captcha carriers catalog charts claims comments compliance consent contacts contracts coupons ' +
  'credits currency customs dashboards deliveries devices discounts disputes documents donations drafts emails ' +
  'exports favorites feedback fees forecasts fulfillment geocode giftcards groups headlines holidays imports insurance ' +
  'inventory invites journals kiosks labels ledgers leases loyalty mailers manifests margins markets media messages ' +
  'metrics notes offers orders packages pallets payouts pickups pricing quotes ratings refunds reviews rewards'
).split(' ');
if (SERVICES.length !== 80) throw new Error(`expected 80 service names, got ${SERVICES.length}`);
const POOL = (
  'adapter agent apply batch bridge broker buffer cache checker cleaner client codec collector compiler composer config ' +
  'cursor decoder digest dispatch encoder engine feed filter finder flow gate guard handler hasher index indexer ' +
  'inspector janitor keeper ledger lexer limiter linker loader locator mapper marker matcher meter mixer monitor ' +
  'notifier packer parser planner poller pool printer probe queue reader reaper recorder relay render resolver ' +
  'router runner sampler scanner scheduler scorer sender shaper signer sink slicer sorter source splitter store ' +
  'streamer syncer tagger tracker tuner validator vault walker watcher weigher writer'
).split(' ');
const LEVEL1 = ['core', 'services', 'web', 'data', 'ops', 'billing', 'identity', 'platform'];

const all = new Map(); // path -> { path, name, parent, children, level, id }
const camel = (p) => p.split('/').slice(1).map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1))).join('') || 'root';
function addBucket(parent, name) {
  const p = parent === null ? 'root' : `${parent}/${name}`;
  const b = { path: p, name, parent, children: [], level: parent === null ? 0 : all.get(parent).level + 1, id: camel(p) };
  all.set(p, b);
  if (parent !== null) all.get(parent).children.push(p);
  return b;
}
addBucket(null, 'root');
for (const n of LEVEL1) addBucket('root', n);
for (const n of SERVICES) addBucket('root/services', n);
for (const n of LEVEL1) {
  if (n === 'services') continue;
  for (const c of shuffle(POOL).slice(0, between(10, 18))) addBucket(`root/${n}`, c);
}
const level2 = [...all.values()].filter((b) => b.level === 2 && !b.path.startsWith('root/services/'));
for (const owner of shuffle(level2).slice(0, 15)) {
  for (const c of shuffle(POOL).slice(0, between(5, 10))) addBucket(owner.path, c);
}

// A random rank per bucket. A contract is generated only when its consumer ranks below the symbol's origin, so the
// bucket graph has no cycle unless one is added on purpose.
const ranks = new Map(shuffle([...all.keys()]).map((p, i) => [p, i]));
const below = (consumer, origin) => ranks.get(consumer) < ranks.get(origin);

// ---------------------------------------------------------------- contracts

const rel = (p) => (p === 'root' ? '' : `${p.slice('root/'.length)}/`);
/** contract file -> [{ names: [{ name, kind, origin }], from }] */
const contracts = new Map();
/** consumer bucket -> [{ file, sym }] */
const consumes = new Map([...all.keys()].map((p) => [p, []]));
const consumedNames = new Map([...all.keys()].map((p) => [p, new Set()]));
const symbolsOf = (b) => [
  { name: `${b.id}Run`, kind: 'run', origin: b.path, file: `${rel(b.path)}_/index` },
  { name: `${b.id}Normalize`, kind: 'fn', origin: b.path, file: `${rel(b.path)}_/util` },
  { name: `${b.id}Limit`, kind: 'const', origin: b.path, file: `${rel(b.path)}_/util` },
  { name: `${b.id}Record`, kind: 'type', origin: b.path, file: `${rel(b.path)}_/types` },
];
function addExport(file, syms, from) {
  if (!contracts.has(file)) contracts.set(file, []);
  contracts.get(file).push({ syms, from });
}
/** Adds a contract whose consumer bucket imports and uses every symbol, unless the consumer already has one of them. */
function contract(file, consumer, syms, from, { use = true } = {}) {
  const fresh = syms.filter((s) => !consumedNames.get(consumer)?.has(s.name));
  if (fresh.length === 0) return false;
  addExport(file, fresh, from);
  if (use && consumer !== null) {
    for (const s of fresh) {
      consumedNames.get(consumer).add(s.name);
      consumes.get(consumer).push({ file, sym: s });
    }
  }
  return true;
}
const dmzFile = (owner, provider, consumer) => `${owner}/dmz/${provider}/${consumer}.ts`;
const spec = (file) => `@A/${file.slice('root/'.length).replace(/\.ts$/, '')}`;

const owners = [...all.values()].filter((b) => b.children.length > 0);
for (const O of owners) {
  const kids = O.children.map((c) => all.get(c));
  const wide = kids.length > 40;
  for (const c of kids) {
    // child to owner, or owner to child
    if (below(O.path, c.path)) {
      if (rnd() < 0.72) contract(dmzFile(O.path, c.name, '.self'), O.path, [symbolsOf(c)[0]], `@A/${symbolsOf(c)[0].file}`);
    } else if (rnd() < 0.62) {
      const s = symbolsOf(O)[1];
      contract(dmzFile(O.path, '.self', c.name), c.path, [s], `@A/${s.file}`);
    }
    // siblings
    const providers = shuffle(kids.filter((s) => s !== c && below(c.path, s.path))).slice(0, wide ? (rnd() < 0.3 ? 2 : 1) : rnd() < 0.3 ? 2 : 1);
    for (const s of providers) {
      const syms = symbolsOf(s);
      const chosen = rnd() < 0.3 ? [syms[1], syms[3]] : [pick([syms[1], syms[2], syms[3]])];
      // A contract re-exports from one file at a time: group by file.
      const byFile = new Map();
      for (const sym of chosen) {
        if (!byFile.has(sym.file)) byFile.set(sym.file, []);
        byFile.get(sym.file).push(sym);
      }
      for (const [file, list] of byFile) contract(dmzFile(O.path, s.name, c.name), c.path, list, `@A/${file}`);
    }
  }
}
// Chains up: a child of O offers to the level above O through dmz/<child>/.parent, and the grandparent passes it to a
// sibling of O (or to its own code).
for (const O of owners) {
  if (O.parent === null) continue;
  const P = all.get(O.parent);
  for (const c of O.children.map((x) => all.get(x))) {
    if (rnd() > 0.22) continue;
    const sym = symbolsOf(c)[2];
    const targets = [...P.children.filter((x) => x !== O.path).map((x) => all.get(x)), P].filter((t) => below(t.path, c.path) && !consumedNames.get(t.path).has(sym.name));
    if (targets.length === 0) continue;
    const t = pick(targets);
    const up = dmzFile(O.path, c.name, '.parent');
    addExport(up, [sym], `@A/${sym.file}`);
    contract(dmzFile(P.path, O.name, t === P ? '.self' : t.name), t.path, [sym], spec(up));
  }
}
// Chains down: what O consumes at the level above, O passes on to a child through dmz/.parent/<child>.
for (const O of owners) {
  if (O.parent === null) continue;
  const P = all.get(O.parent);
  const offered = [...contracts.entries()].filter(([file]) => file.startsWith(`${P.path}/dmz/`) && file.endsWith(`/${O.name}.ts`));
  if (offered.length === 0) continue;
  for (const c of O.children.map((x) => all.get(x))) {
    if (rnd() > 0.25) continue;
    const [file, entries] = pick(offered);
    const sym = pick(entries.flatMap((e) => e.syms));
    if (!below(c.path, sym.origin)) continue;
    contract(dmzFile(O.path, '.parent', c.name), c.path, [sym], spec(file));
  }
}

// ---------------------------------------------------------------- writing the project

function bucketFiles(b, { signature = false, extraImports = [] } = {}) {
  const T = b.id[0].toUpperCase() + b.id.slice(1);
  const files = {};
  files[`${b.path}/_/types.ts`] = `/** One ${b.name} entry as the ${b.path} bucket stores it. */
export interface ${b.id}Record {
  id: string;
  label: string;
  weight: number;
}

export type ${T}Kind = 'draft' | 'active' | 'archived';
`;
  files[`${b.path}/_/util.ts`] = `/** Longest label ${b.path} keeps. */
export const ${b.id}Limit = ${20 + (ranks.get(b.path) % 60)};

/** Trims and lowercases a label for ${b.path}, cut at ${b.id}Limit characters. */
export function ${b.id}Normalize(value: string${signature ? ', max: number = ' + b.id + 'Limit' : ''}): string {
  return value.trim().toLowerCase().slice(0, ${signature ? 'max' : `${b.id}Limit`});
}
`;
  const byFile = new Map();
  for (const { file, sym } of [...consumes.get(b.path), ...extraImports]) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(sym);
  }
  const imports = [...byFile].map(([file, syms]) => {
    const types = syms.filter((s) => s.kind === 'type').map((s) => s.name);
    const values = syms.filter((s) => s.kind !== 'type').map((s) => s.name);
    const from = file.startsWith('@') ? file : spec(file);
    return [
      values.length ? `import { ${values.sort().join(', ')} } from '${from}';` : null,
      types.length ? `import type { ${types.sort().join(', ')} } from '${from}';` : null,
    ].filter(Boolean).join('\n');
  });
  const all2 = [...consumes.get(b.path), ...extraImports].map((x) => x.sym);
  const calls = all2.filter((s) => s.kind !== 'type').map((s) => (s.kind === 'const' ? `String(${s.name})` : s.kind === 'sdk' ? `${s.name}(input).signature` : `${s.name}(input)`));
  const typeUses = all2.filter((s) => s.kind === 'type').map((s) => s.name);
  files[`${b.path}/_/index.ts`] = `${imports.join('\n')}${imports.length ? '\n' : ''}import { ${b.id}Normalize } from '@A/${rel(b.path)}_/util';
import type { ${b.id}Record } from '@A/${rel(b.path)}_/types';

/** Everything ${b.path} consumes through its contracts, as one type. */
export type ${T}Inputs = ${[`${b.id}Record`, ...typeUses].join(' | ')};

/** Runs the ${b.name} step on one input and joins what each dependency returns. */
export function ${b.id}Run(input: string): string {
  const parts: string[] = [${b.id}Normalize(input)];
${calls.map((c) => `  parts.push(${c});`).join('\n')}
  return parts.join('|');
}
`;
  return files;
}

function contractText(file) {
  return contracts
    .get(file)
    .map(({ syms, from }) => {
      const types = syms.filter((s) => s.kind === 'type').map((s) => s.name);
      const values = syms.filter((s) => s.kind !== 'type').map((s) => s.name);
      return [values.length ? `export { ${values.join(', ')} } from '${from}';` : null, types.length ? `export type { ${types.join(', ')} } from '${from}';` : null].filter(Boolean).join('\n');
    })
    .join('\n');
}

let aliasA = '';
function writeShop(extra = {}) {
  const out = (file, text) => write(shop, file, text.split('@A/').join(`${aliasA}/`));
  for (const b of all.values()) {
    const files = bucketFiles(b, { signature: extra.signatures?.has(b.path), extraImports: extra.imports?.get(b.path) ?? [] });
    for (const [f, t] of Object.entries(files)) out(f, t);
  }
  for (const file of contracts.keys()) out(file, contractText(file));
}

// ---------------------------------------------------------------- start from scratch

rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
const api = await loadApi();
const approve = async (...dirs) => {
  for (const dir of dirs) await api.writeLock(dir, await api.computeLock(dir));
};

// The linked SDK project.
write(sdk, 'package.json', json({ name: 'shared-sdk', version: '1.0.0', private: true, type: 'module' }));
write(sdk, 'tsconfig.json', tsconfig('Shared SDK published to the shop.'));
mustBuckets(sdk, 'init', '--yes');
const aliasSdk = readJson(path.join(sdk, 'buckets.config.json')).alias;
write(sdk, 'root/_/main.ts', `import { signRequest } from '${aliasSdk}/dmz/signing/.self';\nconsole.log(signRequest('ping'));\n`);
write(sdk, 'root/dmz/signing/.self.ts', `export { signRequest } from '${aliasSdk}/signing/_/sign';`);
write(sdk, 'root/dmz/signing/.external.ts', `export { signRequest } from '${aliasSdk}/signing/_/sign';\nexport type { SignedRequest } from '${aliasSdk}/signing/_/sign';`);
write(sdk, 'root/signing/_/sign.ts', `export interface SignedRequest {\n  body: string;\n  signature: string;\n}\n\nexport function signRequest(body: string): SignedRequest {\n  return { body, signature: body.length.toString(16) };\n}\n`);
await approve(sdk);

// The shop.
write(shop, 'package.json', json({ name: 'big-shop', version: '3.0.0', private: true, type: 'module' }));
write(shop, 'tsconfig.json', tsconfig('Big shop: about 300 buckets, for measuring buckets inspect.'));
mustBuckets(shop, 'init', '--yes');
const config = readJson(path.join(shop, 'buckets.config.json'));
config.layout = { default: 'deny', allow: [`${config.root}/*/*/*`] };
write(shop, 'buckets.config.json', json(config));
aliasA = config.alias;
writeShop();

// History for the timeline: each approval is a commit, with a fixed author and date.
const git = (gitArgs, date) =>
  execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...gitArgs], {
    cwd: shop,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
const commit = (message, date) => {
  git(['add', '-A'], date);
  git(['commit', '-q', '-m', message], date);
};
if (withGit) {
  appendFileSync(path.join(shop, '.gitignore'), 'node_modules/\n.buckets/\n');
  git(['init', '-q'], '2026-09-01T10:00:00Z');
  await approve(shop);
  commit('Approve the buckets of the shop', '2026-09-01T10:00:00Z');
}

// Nested project in root/web/_/widgetkit.
const kit = path.join(shop, 'root', 'web', '_', 'widgetkit');
write(kit, 'package.json', json({ name: '@big/widgetkit', version: '0.2.0', private: true, type: 'module' }));
write(kit, 'tsconfig.json', tsconfig('Widget kit nested in the web bucket.'));
mustBuckets(kit, 'init', '--yes');
const aliasKit = readJson(path.join(kit, 'buckets.config.json')).alias;
write(kit, 'root/_/index.ts', `import { renderBadge } from '${aliasKit}/dmz/badges/.self';\nconsole.log(renderBadge('new'));\n`);
write(kit, 'root/dmz/badges/.self.ts', `export { renderBadge } from '${aliasKit}/badges/_/badge';`);
write(kit, 'root/badges/_/badge.ts', `export function renderBadge(text: string): string {\n  return '<span class="badge">' + text + '</span>';\n}\n`);

// The link: platform's first child consumes the SDK.
const linkBucket = all.get('root/platform').children[0];
mustBuckets(shop, 'link', 'add', 'sdk', path.relative(shop, sdk), '--bucket', linkBucket);
const sdkSym = { name: 'signRequest', kind: 'sdk', origin: null };
consumes.get(linkBucket).push({ file: `${aliasSdk}/dmz/signing/.external`, sym: sdkSym });
writeShop();

await approve(kit, shop);
if (withGit) commit('Nest widgetkit in web and link shared-sdk', '2026-09-09T15:30:00Z');
// A third approval: two services take a max parameter in their normalize function.
const approvedSignatures = new Set();
if (withGit) {
  const kids = all.get('root/services').children.map((c) => all.get(c));
  const offered = new Set([...contracts.values()].flat().flatMap((e) => e.syms.filter((x) => x.kind === 'fn').map((x) => x.origin)));
  for (const b of kids.slice(12, 20).filter((k) => offered.has(k.path)).slice(0, 2)) approvedSignatures.add(b.path);
  writeShop({ signatures: approvedSignatures });
  await approve(shop);
  commit('Approve a max parameter in two normalize functions', '2026-09-18T09:15:00Z');
}
if (verify) {
  const tc = typecheck(shop);
  console.log(`tsc --noEmit big-shop (approved state): exit ${tc.code}${tc.code ? `\n${tc.out.split('\n').slice(0, 20).join('\n')}` : ''}`);
}
const approvedCheck = buckets(shop, 'check');
console.log(`check (approved state): exit ${approvedCheck.code}${approvedCheck.code ? `\n${approvedCheck.out.slice(0, 2000)}` : ''}`);

// ---------------------------------------------------------------- working tree: violations and lock differences

const services = all.get('root/services');
const svcKids = services.children.map((c) => all.get(c));
// A cycle between two services that each consume the other.
const [ca, cb] = [svcKids[3], svcKids[4]];
contract(dmzFile(services.path, ca.name, cb.name), cb.path, [symbolsOf(ca)[0]], `@A/${symbolsOf(ca)[0].file}`);
contract(dmzFile(services.path, cb.name, ca.name), ca.path, [symbolsOf(cb)[0]], `@A/${symbolsOf(cb)[0].file}`);
// Two forbidden imports: straight into another bucket's _/.
const extraImports = new Map();
const forbid = (from, to) => {
  const s = symbolsOf(to)[1];
  extraImports.set(from.path, [...(extraImports.get(from.path) ?? []), { file: `@A/${s.file}`, sym: s }]);
};
forbid(svcKids[10], svcKids[11]);
const deep = [...all.values()].filter((b) => b.level === 3);
forbid(deep[0], deep[deep.length - 1]);
// Two orphans: a symbol re-exported that nobody imports.
let orphans = 0;
for (const [file, entries] of contracts) {
  if (orphans >= 2 || file.endsWith('/.parent.ts') || file.includes('/.parent/') || entries.length !== 1) continue;
  const entry = entries[0];
  if (!entry.from.endsWith('_/util')) continue;
  const origin = all.get(entry.syms[0].origin);
  const extra = symbolsOf(origin).find((s) => s.file === entry.syms[0].file && !entry.syms.some((x) => x.name === s.name));
  if (!extra) continue;
  entry.syms.push(extra);
  orphans++;
}
// Lock differences: three changed signatures, a new contract, a new bucket.
const exported = new Set([...contracts.values()].flat().flatMap((e) => e.syms.filter((x) => x.kind === 'fn').map((x) => x.origin)));
const signatures = new Set(svcKids.slice(20).filter((b) => exported.has(b.path)).slice(0, 3).map((b) => b.path));
const newBucket = addBucket('root/ops', 'newcomer');
ranks.set(newBucket.path, -1);
consumes.set(newBucket.path, []);
consumedNames.set(newBucket.path, new Set());
const ops = all.get('root/ops');
contract(dmzFile(ops.path, newBucket.name, '.self'), ops.path, [symbolsOf(newBucket)[0]], `@A/${symbolsOf(newBucket)[0].file}`);
writeShop({ signatures: new Set([...approvedSignatures, ...signatures]), imports: extraImports });

// ---------------------------------------------------------------- verification

const report = JSON.parse(buckets(shop, 'check', '--json').out);
const count = (list, key) => Object.entries(list.reduce((m, x) => ((m[x[key]] = (m[x[key]] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`\nbuckets: ${all.size}, contracts written: ${contracts.size}, files in _/: ${all.size * 3}`);
console.log(`check exit ${report.exitCode}`);
console.log(`violations: ${report.violations.length} (${count(report.violations, 'rule')})`);
console.log(`lock changes: ${report.lockChanges.length} (${count(report.lockChanges, 'kind')})`);
if (verify) {
  const tc2 = typecheck(shop);
  console.log(`tsc --noEmit big-shop (working tree): exit ${tc2.code}`);
}
console.log(`ready: ${shop}`);

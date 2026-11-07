#!/usr/bin/env node
// Generates TypeScript projects for slopbuckets 2.0: the stress projects of the benchmark (scripts/bench.mjs) and the
// medium shop of the site demo (scripts/site-demo.mjs). The same options and seed give the same files and the same
// git commit hash.
//
//   node scripts/stress-project.mjs [outDir] [--preset NAME] [options]
//
// Without --preset and --files it builds the shop in <outDir>/big-shop, which is what site-demo.mjs runs inspect on.
// Every other preset writes the project into outDir itself. outDir defaults to examples/.tmp/stress and is deleted
// first. Every project is a git repository with one commit, so --git is accepted and does nothing.
//
// Options (defaults in DEFAULTS, presets in PRESETS):
//   --seed N             seed of the random choices
//   --files N            source files in the repository, nested project and injected violations included
//   --buckets N          buckets of the synthetic graph
//   --fanout N           each bucket depends on up to N buckets ranked after it (a realistic spread)
//   --chain N            buckets 0..N-1 form a chain, each depending on the next (a deep graph)
//   --hub N              buckets 0..N-1 depend on the last bucket (a wide graph)
//   --exclude-every N    every Nth bucket is a vendor/ folder that its parent excludes with a ! glob
//   --big-file           one module has 20,000 lines and 400 imports
//   --extends N          tsconfig.json extends a chain of N files; the nearest one holds baseUrl and the paths
//   --workspace KIND     npm, pnpm or none: the last buckets live in workspace packages linked into node_modules
//   --packages N         number of workspace packages
//   --hostile-names      some bucket folders and file names have spaces and uppercase letters
//   --nested             a nested project in nested/sdk, listed in projects
//   --violations LIST    rule=count pairs, such as dependency-undeclared=3,file-unowned=1; RULES lists the rules
//
// The clean project has no violation: every declared dependency is imported, every name of a public file is
// imported by another bucket, and every bucket imports only public files of declared dependencies. Each violation
// count adds exactly that many violations of the rule.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  'config-invalid',
  'config-cycle',
  'dependency-undeclared',
  'dependency-unused',
  'import-private',
  'import-ignored',
  'import-dynamic',
  'import-namespace',
  'file-unowned',
  'file-overlap',
  'glob-empty',
  'public-missing',
  'public-not-interface',
  'project-undeclared',
  'export-unused',
  'import-unresolved',
  'package-undeclared',
  'package-unused',
];

export const DEFAULTS = {
  seed: 1,
  files: 1000,
  buckets: 50,
  fanout: 4,
  chain: 0,
  hub: 0,
  excludeEvery: 10,
  bigFile: false,
  extendsDepth: 2,
  workspace: 'none',
  packages: 2,
  hostileNames: false,
  nested: false,
  violations: {},
};

const oneOfEach = Object.fromEntries(RULES.filter((r) => r !== 'config-invalid').map((r) => [r, 1]));
const STRESS = { buckets: 500, fanout: 8, chain: 50, hub: 300, excludeEvery: 25, bigFile: true, extendsDepth: 3, hostileNames: true, nested: true, violations: oneOfEach };

export const PRESETS = {
  shop: { shop: true, seed: 20261004 },
  tiny: { files: 40, buckets: 6, fanout: 2, excludeEvery: 0, extendsDepth: 1 },
  '1k': { files: 1000, buckets: 50 },
  '10k': { ...STRESS, files: 10000, workspace: 'npm' },
  '50k': { ...STRESS, files: 50000, workspace: 'pnpm' },
};

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TYPED = new Set(['.ts', '.tsx', '.mts']);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const camel = (s) => s.replace(/[-\s]+(\w)/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^\w/, (c) => c.toUpperCase());

/** mulberry32: seeded random numbers in [0, 1). */
function random(seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(rnd() * n);
  return { rnd, int, pick: (list) => list[int(list.length)], chance: (p) => rnd() < p };
}

function rel(from, to) {
  const r = path.posix.relative(path.posix.dirname(from), to);
  return r.startsWith('.') ? r : `./${r}`;
}
/** A relative specifier from one file to a module, in the forms TypeScript accepts for its extension. */
function relSpec(r, from, to) {
  const ext = path.posix.extname(to);
  const bare = rel(from, to).slice(0, -ext.length);
  if (ext === '.mts' || ext === '.mjs') return `${bare}.mjs`;
  if (ext === '.cts' || ext === '.cjs') return `${bare}.cjs`;
  return r.chance(0.3) ? `${bare}.js` : bare;
}

// ------------------------------------------------------------------ plans
// A plan is { buckets, ignore, projects, files: Map(path -> text), links: [[link, target]], paths, packageJson }.
// A bucket is { name, dir, purpose, deps: Map(name -> reason), files: globs, modules, public, exports, external }.
// A module is { path, ext, fn, value, type, imports: [line], body: [line], big }.

function module(path_, fn, value, type) {
  const ext = path.posix.extname(path_);
  return { path: path_, ext, fn, value, type: TYPED.has(ext) ? type : null, imports: [], body: [], big: false };
}

function stressPlan(o, r) {
  const B = o.buckets;
  const width = String(B - 1).length;
  const buckets = [];
  for (let i = 0; i < B; i++) {
    const name = `b${String(i).padStart(width, '0')}`;
    buckets.push({ name, i, dir: `src/${name}`, purpose: `Synthetic bucket ${name} of the stress project`, deps: new Map(), files: null, modules: [] });
  }
  const dep = (a, b) => a !== b && a.deps.set(b.name, `Reads the records that ${b.name} keeps`);
  for (let i = 0; i + 1 < Math.min(o.chain, B); i++) dep(buckets[i], buckets[i + 1]);
  for (let i = 0; i < Math.min(o.hub, B - 1); i++) dep(buckets[i], buckets[B - 1]);
  for (const b of buckets) for (let k = 0; k < o.fanout && b.i < B - 1; k++) dep(b, buckets[b.i + 1 + r.int(B - 1 - b.i)]);

  // Folders: workspace packages for the last buckets but the hub, then hostile names, then vendor folders.
  const special = new Set();
  const pkgs = o.workspace === 'none' ? [] : buckets.slice(Math.max(1, B - 1 - o.packages), B - 1);
  for (const b of pkgs) {
    b.dir = `packages/${b.name}/src`;
    b.pkg = `@acme/${b.name}`;
    special.add(b);
  }
  if (o.hostileNames) {
    // Buckets 7, 57, 107... (bucket 7 % B in a small project).
    for (const b of buckets) {
      if (b.i % 50 !== 7 % B || special.has(b)) continue;
      b.dir = `src/Legacy Area ${b.i}`;
      b.hostile = true;
      special.add(b);
    }
  }
  for (const b of buckets) b.files = [`${b.dir}/**`];
  if (o.excludeEvery > 1) {
    for (const b of buckets) {
      const parent = buckets[b.i - 1];
      if (b.i % o.excludeEvery !== o.excludeEvery - 1 || !parent || special.has(b) || special.has(parent) || parent.vendor) continue;
      b.dir = `${parent.dir}/vendor`;
      b.vendor = true;
      b.files = [`${b.dir}/**`];
      parent.files.push(`!${parent.dir}/vendor/**`);
    }
  }
  return { buckets, ignore: ['**/*.test.ts', 'scripts/**', 'fixtures/**'], projects: [] };
}

/** Spreads `total` modules over the buckets: at least 2 each, the rest by random weights. */
function addStressModules(plan, total, r) {
  const { buckets } = plan;
  if (total < 2 * buckets.length) throw new Error(`${total} modules are too few for ${buckets.length} buckets; raise --files or lower --buckets`);
  const weights = buckets.map(() => 0.5 + r.rnd());
  const sum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => 2 + Math.floor(((total - 2 * buckets.length) * w) / sum));
  for (let i = 0, left = total - counts.reduce((a, b) => a + b, 0); left > 0; i++, left--) counts[i % counts.length]++;
  const subs = ['core', 'util', 'ui', 'model', 'core/deep'];
  let k = 0;
  buckets.forEach((b, i) => {
    for (let n = 0; n < counts[i]; n++, k++) {
      const x = r.rnd();
      const ext = n === 0 ? '.ts' : x < 0.85 ? '.ts' : x < 0.93 ? '.tsx' : x < 0.97 ? '.js' : '.mts';
      const sub = b.vendor || b.pkg ? '' : `${r.pick(subs)}/`;
      const base = b.hostile && n % 2 ? `Module ${k}` : `m${k}`;
      b.modules.push(module(`${b.dir}/${sub}${base}${ext}`, `f${k}`, `c${k}`, `T${k}`));
    }
  });
}

// The site demo: a medium shop with layered buckets, written by hand. [name, purpose, modules, { dependency: reason }]
const SHOP = [
  ['app', 'Starts the server and wires the routes, jobs and settings', 'main boot', { routes: 'Mounts every HTTP route', jobs: 'Starts the background jobs', config: 'Reads settings at boot', log: 'Logs startup and shutdown' }],
  ['routes', 'Maps HTTP paths to the feature handlers', 'router storefront account admin errors', { checkout: 'Serves the checkout pages', cart: 'Serves the cart API', catalog: 'Serves product pages', orders: 'Serves order history', auth: 'Guards private routes', search: 'Serves the search box', reviews: 'Serves product reviews', admin: 'Serves the back office', http: 'Parses requests and writes responses' }],
  ['jobs', 'Runs scheduled work such as reminders and stock syncs', 'scheduler reminders stock-sync', { notifications: 'Sends abandoned cart reminders', inventory: 'Syncs stock levels nightly', queue: 'Pulls scheduled work', log: 'Logs each run' }],
  ['admin', 'Back office for staff: refunds, stock and promotions', 'dashboard refunds stock promotions', { orders: 'Lists and edits orders', returns: 'Approves returns', inventory: 'Edits stock by hand', promotions: 'Creates discount codes', auth: 'Checks staff roles' }],
  ['checkout', 'Turns a cart into a paid order', 'service steps validate summary', { cart: 'Reads the items to buy', pricing: 'Computes the final total', payments: 'Charges the customer', orders: 'Creates the order', shipping: 'Books the delivery', customers: 'Reads the buyer address', events: 'Publishes checkout events' }],
  ['cart', 'Keeps the items a customer wants to buy', 'service store types merge', { catalog: 'Checks that products exist', pricing: 'Shows line prices', cache: 'Keeps carts in memory' }],
  ['catalog', 'Products, categories and their pages', 'products categories media types', { db: 'Stores products', storage: 'Keeps product images', i18n: 'Translates product names' }],
  ['search', 'Finds products by text and filters', 'index query ranking', { catalog: 'Indexes the products', cache: 'Caches popular queries' }],
  ['reviews', 'Product ratings and comments from buyers', 'service moderation types', { catalog: 'Links reviews to products', customers: 'Shows the reviewer name', db: 'Stores reviews' }],
  ['orders', 'Order records and their status changes', 'service repository status types', { db: 'Stores orders', events: 'Publishes status changes', money: 'Keeps order totals' }],
  ['returns', 'Return requests and refunds', 'service policy types', { orders: 'Finds the returned order', payments: 'Refunds the charge', notifications: 'Tells the customer' }],
  ['payments', 'Charges and refunds through the card gateway', 'gateway charges refunds webhooks', { money: 'Converts amounts to cents', 'http-client': 'Calls the gateway API', events: 'Publishes payment events', log: 'Logs failed charges' }],
  ['shipping', 'Delivery quotes, labels and tracking', 'carriers quotes labels tracking', { 'http-client': 'Calls the carrier APIs', money: 'Prices deliveries', customers: 'Reads the delivery address' }],
  ['inventory', 'Stock levels per warehouse', 'stock warehouses reservations', { db: 'Stores stock', events: 'Publishes low stock alerts' }],
  ['pricing', 'Prices, taxes and discounts', 'prices taxes discounts', { promotions: 'Applies active discount codes', money: 'Does price arithmetic', catalog: 'Reads list prices' }],
  ['promotions', 'Discount codes and campaigns', 'codes campaigns rules', { db: 'Stores discount codes', money: 'Caps discount amounts' }],
  ['customers', 'Customer profiles and addresses', 'profiles addresses types', { db: 'Stores profiles', i18n: 'Formats addresses per country' }],
  ['auth', 'Sign in, sessions and staff roles', 'sessions passwords roles', { customers: 'Loads the signed-in customer', cache: 'Keeps sessions', config: 'Reads the session secret' }],
  ['notifications', 'Emails and texts to customers', 'templates sender preferences', { email: 'Sends the emails', customers: 'Reads contact preferences', i18n: 'Translates the templates', queue: 'Sends in the background' }],
  ['email', 'Sends email through the mail provider', 'client templates', { 'http-client': 'Calls the mail provider', config: 'Reads the API key' }],
  ['events', 'In-process event bus for domain events', 'bus types', { queue: 'Hands events to background workers' }],
  ['queue', 'Background job queue', 'client worker', { config: 'Reads the queue address', log: 'Logs failed jobs' }],
  ['db', 'Database connection and migrations', 'pool migrations transactions', { config: 'Reads the database address', log: 'Logs slow queries' }],
  ['cache', 'In-memory cache with expiry', 'store expiry', {}],
  ['storage', 'File storage for images and exports', 'client paths', { config: 'Reads the bucket name' }],
  ['http', 'Request parsing and response helpers', 'request response errors', { log: 'Logs failed requests' }],
  ['http-client', 'Outgoing HTTP calls with retries', 'client retry', { log: 'Logs failed calls' }],
  ['money', 'Amounts in cents and currency rules', 'amount currency rounding', {}],
  ['i18n', 'Translations and locale formats', 'messages formats', {}],
  ['config', 'Settings read from the environment', 'env schema', {}],
  ['log', 'Structured logs', 'logger levels', {}],
];

function shopPlan() {
  const buckets = SHOP.map(([name, purpose, mods, deps]) => {
    const b = { name, dir: `src/${name}`, purpose, deps: new Map(Object.entries(deps)), files: [`src/${name}/**`], modules: [] };
    for (const m of mods.split(' ')) b.modules.push(module(`${b.dir}/${m}.ts`, camel(`${name}-${m}`), camel(`${name}-${m}-defaults`), pascal(`${name}-${m}`)));
    return b;
  });
  return { buckets, ignore: ['**/*.test.ts', 'scripts/**', 'fixtures/**'], projects: [] };
}

// ------------------------------------------------------------------ imports

function crossSpec(r, from, b) {
  if (b.pkg) return b.pkg;
  const x = r.rnd();
  if (x < 0.45 && b.dir.startsWith('src/')) return `@b/${b.dir.slice(4)}`;
  if (x < 0.7) return `@${b.name}`;
  if (x < 0.9) return relSpec(r, from.path, `${b.dir}/index.ts`);
  return `${b.dir}/index`;
}

function importLine(r, names, types, spec) {
  if (!types.length) return [`import { ${names.join(', ')} } from '${spec}';`];
  if (!names.length || r.chance(0.5)) return [names.length ? `import { ${names.join(', ')} } from '${spec}';` : null, `import type { ${types.join(', ')} } from '${spec}';`].filter(Boolean);
  return [`import { ${names.join(', ')}, ${types.map((t) => `type ${t}`).join(', ')} } from '${spec}';`];
}

/** Modules that may carry imports of types and injected lines: typed, not the big file. */
const typedModules = (b) => b.modules.filter((m) => m.type && !m.big);

/**
 * Wires the clean graph: public files for buckets with dependents (null for the others), one import per declared
 * dependency, every public name imported at least once, and imports between modules of the same bucket.
 */
function wire(plan, r) {
  const byName = new Map(plan.buckets.map((b) => [b.name, b]));
  const dependents = new Map(plan.buckets.map((b) => [b.name, []]));
  for (const a of plan.buckets) for (const d of a.deps.keys()) dependents.get(d).push(a);
  for (const b of plan.buckets) {
    const users = dependents.get(b.name);
    b.exports = [];
    b.publicLines = [];
    if (!users.length) {
      b.public = null;
      continue;
    }
    b.public = `${b.dir}/index.ts`;
    const candidates = typedModules(b);
    const chosen = new Set();
    while (chosen.size < Math.min(candidates.length, 1 + r.int(4))) chosen.add(r.pick(candidates));
    for (const m of chosen) {
      const spec = relSpec(r, b.public, m.path);
      b.publicLines.push(`export { ${m.fn}, ${m.value} as ${m.value}Default } from '${spec}';`, `export type { ${m.type} } from '${spec}';`);
      b.exports.push({ name: m.fn }, { name: `${m.value}Default` }, { name: m.type, type: true });
    }
    // Each dependent imports at least one name, and each name has at least one importer.
    const want = new Map(users.map((u) => [u, new Set()]));
    users.forEach((u, i) => want.get(u).add(b.exports[i % b.exports.length]));
    for (let i = users.length; i < b.exports.length; i++) want.get(r.pick(users)).add(b.exports[i]);
    for (const [u, names] of want) {
      const m = r.pick(typedModules(u));
      const list = [...names];
      m.imports.push(...importLine(r, list.filter((n) => !n.type).map((n) => n.name), list.filter((n) => n.type).map((n) => n.name), crossSpec(r, m, b)));
    }
  }
  for (const b of plan.buckets) {
    for (const m of b.modules) {
      const others = b.modules.filter((x) => x !== m && !x.big);
      if (!others.length) continue;
      if (m.big) {
        for (let i = 0; i < 400; i++) {
          const t = others[i % others.length];
          m.imports.push(`import { ${t.fn} as ${t.fn}At${i} } from '${relSpec(r, m.path, t.path)}';`);
        }
        continue;
      }
      const seen = new Set();
      for (let i = 0, n = 1 + r.int(4); i < n; i++) {
        const t = r.pick(others);
        if (seen.has(t)) continue;
        seen.add(t);
        const spec = relSpec(r, m.path, t.path);
        if (m.type && t.type && r.chance(0.2)) m.imports.push(`import type { ${t.type} } from '${spec}';`);
        else m.imports.push(`import { ${t.fn}, ${t.value} } from '${spec}';`);
      }
      if (r.chance(0.05)) {
        const [key, line] = r.pick([['node:path', "import path from 'node:path';"], ['zod-lite', "import { z } from 'zod-lite';"], ['node:fs', "import { readFileSync } from 'node:fs';"]]);
        m.imports.push(line);
        (b.packages ??= new Map()).set(key, `Imported by ${m.path} of the stress project`);
      }
      if (r.chance(0.05)) {
        const t = r.pick(others);
        m.body.push(`export async function load${pascal(m.fn)}() {`, `  const { ${t.fn} } = await import('${relSpec(r, m.path, t.path)}');`, `  return ${t.fn};`, '}');
      }
    }
  }
  return byName;
}

// ------------------------------------------------------------------ violations

/**
 * Adds exactly `count` violations of each rule. Every choice avoids the modules, buckets and bucket pairs that an
 * earlier injection used, so two injections never merge into one violation or cancel each other.
 */
function inject(plan, violations, r, byName) {
  const usedModules = new Set();
  const usedPairs = new Set();
  const usedPublics = new Set();
  const pair = (a, b) => `${a.name}>${b.name}`;
  const withPublic = plan.buckets.filter((b) => b.public);
  const freeModule = (b) => {
    const m = typedModules(b).find((x) => !usedModules.has(x));
    if (m) usedModules.add(m);
    return m;
  };
  const tries = (what, fn) => {
    for (let i = 0; i < 10_000; i++) if (fn()) return;
    throw new Error(`could not place a ${what} violation; the project is too small for the requested counts`);
  };
  // Topological rank: every declared dependency goes from a lower rank to a higher one, so a new dependency from a
  // lower to a higher rank never closes a cycle.
  const ranked = new Map();
  let finished = 0;
  const visit = (b) => {
    if (ranked.has(b)) return;
    ranked.set(b, 0);
    for (const d of b.deps.keys()) visit(byName.get(d));
    ranked.set(b, -++finished);
  };
  plan.buckets.forEach(visit);
  const n = (rule) => violations[rule] ?? 0;
  for (const rule of Object.keys(violations)) if (!RULES.includes(rule)) throw new Error(`unknown rule ${rule}`);

  for (let k = 0; k < n('config-invalid'); k++) plan.buckets[0].deps.set(`missing-${k}`, 'Points at a bucket that does not exist');
  for (let k = 0; k < n('config-cycle'); k++) {
    tries('config-cycle', () => {
      const a = r.pick(withPublic);
      const b = byName.get(r.pick([...a.deps.keys()]));
      if (!b || usedPairs.has(pair(a, b)) || usedPairs.has(pair(b, a))) return false;
      const m = freeModule(b);
      if (!m) return false;
      usedPairs.add(pair(a, b)).add(pair(b, a));
      b.deps.set(a.name, `Calls back into ${a.name}`);
      m.imports.push(`import { ${a.exports[0].name} } from '${crossSpec(r, m, a)}';`);
      return true;
    });
  }
  const undeclared = (rule, apply) => {
    for (let k = 0; k < n(rule); k++) {
      tries(rule, () => {
        const a = r.pick(plan.buckets);
        const b = r.pick(withPublic);
        if (a === b || a.deps.has(b.name) || b.deps.has(a.name) || usedPairs.has(pair(a, b))) return false;
        return apply(a, b, k) && usedPairs.add(pair(a, b));
      });
    }
  };
  undeclared('dependency-undeclared', (a, b) => {
    const m = freeModule(a);
    return m && m.imports.push(`import { ${b.exports[0].name} } from '${crossSpec(r, m, b)}';`);
  });
  // An unresolved import holds back the dependency-unused of its bucket, so import-unresolved avoids these buckets.
  const unusedFrom = new Set();
  undeclared('dependency-unused', (a, b) => ranked.get(a) < ranked.get(b) && unusedFrom.add(a) && a.deps.set(b.name, `Planned use of ${b.name}`));
  const onDeclared = (rule, apply) => {
    for (let k = 0; k < n(rule); k++) {
      tries(rule, () => {
        const a = r.pick(plan.buckets);
        const b = byName.get(r.pick([...a.deps.keys()]));
        if (!b?.public) return false;
        const m = freeModule(a);
        return m && apply(a, b, m, k);
      });
    }
  };
  onDeclared('import-private', (a, b, m) => {
    const t = r.pick(b.modules.filter((x) => !x.big));
    return m.imports.push(`import { ${t.fn} as private${pascal(t.fn)} } from '${relSpec(r, m.path, t.path)}';`);
  });
  onDeclared('import-namespace', (a, b, m, k) => m.imports.push(`import * as space${k} from '${crossSpec(r, m, b)}';`));
  const inModule = (rule, apply) => {
    for (let k = 0; k < n(rule); k++) {
      tries(rule, () => {
        const m = freeModule(r.pick(plan.buckets));
        return m && (apply(m, k) ?? true);
      });
    }
  };
  inModule('import-ignored', (m) => m.imports.push(`import { sampleOrders } from '${relSpec(r, m.path, 'fixtures/sample-orders.ts')}';`));
  inModule('import-dynamic', (m, k) => m.body.push(`export const loadByName${k} = (name: string) => import(name);`));
  // The missing file would be in the importing bucket, so the import holds back only the export-unused of that
  // bucket, and the public rules leave its public file alone.
  for (let k = 0; k < n('import-unresolved'); k++) {
    tries('import-unresolved', () => {
      const a = r.pick(plan.buckets);
      const m = !unusedFrom.has(a) && !usedPublics.has(a) && freeModule(a);
      if (!m) return false;
      usedPublics.add(a);
      return m.imports.push(`import { gone${k} } from '${relSpec(r, m.path, `${a.dir}/gone-${k}.ts`)}';`);
    });
  }
  inModule('package-undeclared', (m, k) => m.imports.push(`import { left${k} } from 'undeclared-package-${k}';`));
  for (let k = 0; k < n('package-unused'); k++) (r.pick(plan.buckets).packages ??= new Map()).set(`planned-package-${k}`, 'Declared for an import that no file has yet');
  for (let k = 0; k < n('file-unowned'); k++) plan.files.set(`orphans/orphan-${k}.ts`, `// In no bucket.\nexport const orphan${k} = ${k};\n`);
  for (let k = 0; k < n('file-overlap'); k++) {
    tries('file-overlap', () => {
      const a = r.pick(plan.buckets);
      const c = r.pick(plan.buckets);
      if (a === c || a.vendor || c.vendor) return false;
      const file = `${a.dir}/overlap-${k}.ts`;
      plan.files.set(file, `// Matched by ${a.name} and ${c.name}.\nexport const overlap${k} = ${k};\n`);
      c.files.push(file);
      return true;
    });
  }
  for (let k = 0; k < n('glob-empty'); k++) r.pick(plan.buckets).files.push(`src/missing-${k}/**`);
  for (let k = 0; k < n('public-missing'); k++) {
    const dir = `ghosts/ghost-${k}`;
    plan.buckets.push({ name: `ghost-${k}`, dir, purpose: 'Bucket whose public file was deleted', deps: new Map(), files: [`${dir}/**`], modules: [], public: `${dir}/index.ts`, exports: [], publicLines: [] });
    plan.files.set(`${dir}/impl.ts`, `export const ghost${k} = ${k};\n`);
  }
  const onPublic = (rule, apply) => {
    for (let k = 0; k < n(rule); k++) {
      tries(rule, () => {
        const b = r.pick(withPublic);
        if (usedPublics.has(b)) return false;
        usedPublics.add(b);
        apply(b, k);
        return true;
      });
    }
  };
  onPublic('public-not-interface', (b) => b.publicLines.push('const loadedAt = Date.now();', 'void loadedAt;'));
  onPublic('export-unused', (b, k) => {
    const m = b.modules.find((x) => !x.big);
    b.publicLines.push(`export { ${m.value} as unused${k} } from '${relSpec(r, b.public, m.path)}';`);
  });
  for (let k = 0; k < n('project-undeclared'); k++) plan.files.set(`tools/rogue-${k}/buckets.config.json`, json({ version: '2.0', buckets: {} }));
}

// ------------------------------------------------------------------ rendering

function filler(m, r) {
  const ts = m.type !== null;
  const t = (x) => (ts ? x : '');
  const lines = [];
  for (let i = 0, n = 2 + r.int(3); i < n; i++) {
    lines.push(
      '/**',
      ` * Helper ${i}. Example: import thing from 'not-a-real-import'; require('nope');`,
      ' */',
      `function helper${i}(input${t(': string')}, count${t(' = 0')})${t(': string')} {`,
      "  const pattern = /import\\s+['\"]x['\"]|require\\(['\"]y['\"]\\)/g;",
      "  const label = `item ${input} of ${count > 1 ? `${count} items` : 'one'} // not a comment`;",
      "  if (count > 10) return label.replace(pattern, '') + \"import('fake')\";",
      '  // const x = await import(\'./commented-out\');',
      "  return label + String(count / 2) + '\\'';",
      '}',
    );
  }
  if (m.ext === '.tsx') lines.push(`export function View${pascal(m.fn)}(props: { label: string }) {`, '  return <div className="view">{props.label} is not empty</div>;', '}');
  return lines;
}

function renderModule(m, r) {
  const ts = m.type !== null;
  const out = [`// ${m.fn} and the helpers it needs.`, ...m.imports, ''];
  if (m.big) {
    for (let i = 0; out.length < 20_000 - 5; i++) out.push(`export const row${i} = { id: ${i}, label: 'row ${i}', weight: ${(i % 97) / 97} };`);
  } else {
    out.push(...filler(m, r), ...m.body);
  }
  if (ts) out.push(`export type ${m.type} = { id: number; name: string };`);
  out.push(`export function ${m.fn}(input${ts ? ': string' : ''}) {`, `  return input + '${m.fn}';`, '}', `export const ${m.value} = ${JSON.stringify(m.fn.length)};`);
  return `${out.join('\n')}\n`;
}

function nestedProject(files, dir, name) {
  const cfg = {
    $schema: 'https://nicolascaous.github.io/slopbuckets/schema/v2.json',
    version: '2.0',
    ignore: [],
    projects: [],
    buckets: {
      client: { purpose: 'Typed client for the public API', files: ['src/client/**'], public: 'src/client/index.ts', dependsOn: { types: 'Returns the shared models' }, packages: {}, external: 'Entry of the npm package' },
      types: { purpose: 'Models shared by the client and its users', files: ['src/types/**'], public: 'src/types/index.ts', dependsOn: {}, packages: {} },
    },
  };
  files.set(`${dir}/buckets.config.json`, json(cfg));
  files.set(`${dir}/package.json`, json({ name, version: '0.1.0', private: true, type: 'module' }));
  files.set(`${dir}/tsconfig.json`, json({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true }, include: ['src'] }));
  files.set(`${dir}/src/types/model.ts`, 'export interface Model {\n  id: string;\n}\n');
  files.set(`${dir}/src/types/index.ts`, "export type { Model } from './model';\n");
  files.set(`${dir}/src/client/http.ts`, "import type { Model } from '../types/index';\n\nexport async function fetchModel(id: string): Promise<Model> {\n  return { id };\n}\n");
  files.set(`${dir}/src/client/index.ts`, "export { fetchModel } from './http';\n");
}

function render(plan, o, r) {
  const files = plan.files;
  for (const b of plan.buckets) {
    if (b.public && b.modules.length) files.set(b.public, `${b.publicLines.join('\n')}\n`);
    for (const m of b.modules) files.set(m.path, renderModule(m, r));
  }
  // Test files next to evenly spread modules, so the count is exact.
  const tested = plan.buckets.flatMap(typedModules);
  for (let i = 0; i < plan.tests; i++) {
    const m = tested[Math.floor((i * tested.length) / plan.tests)];
    const test = m.path.replace(/\.(ts|tsx|mts)$/, '.test.ts');
    files.set(test, `import { ${m.fn} } from '${relSpec(r, test, m.path)}';\n\nif (${m.fn}('x') === '') throw new Error('${m.fn}');\n`);
  }
  const pub = plan.buckets.find((b) => b.public && b.modules.length);
  files.set('fixtures/sample-orders.ts', 'export const sampleOrders = [{ id: 1, total: 1200 }];\n');
  for (const s of ['seed', 'report', 'migrate']) files.set(`scripts/${s}.mjs`, `import { ${pub.exports[0].name} } from '../${pub.public}';\n\nconsole.log(${pub.exports[0].name});\n`);

  const config = { $schema: 'https://nicolascaous.github.io/slopbuckets/schema/v2.json', version: '2.0', ignore: plan.ignore, projects: plan.projects, buckets: {} };
  for (const b of plan.buckets) {
    config.buckets[b.name] = { purpose: b.purpose, files: b.files, public: b.public, dependsOn: Object.fromEntries(b.deps), packages: Object.fromEntries(b.packages ?? []) };
    if (b.external) config.buckets[b.name].external = b.external;
  }
  files.set('buckets.config.json', json(config));

  // tsconfig.json extends config/tsconfig.1.json, which holds baseUrl and the paths and extends tsconfig.2.json...
  const paths = { '@b/*': ['src/*'] };
  for (const b of plan.buckets) if (b.public && !b.pkg) paths[`@${b.name}`] = [b.public];
  const depth = Math.max(1, o.extendsDepth);
  files.set('tsconfig.json', json({ extends: './config/tsconfig.1.json', include: ['src', 'packages', 'scripts', 'fixtures', 'orphans', 'ghosts'] }));
  for (let i = 1; i <= depth; i++) {
    const options = i === 1 ? { baseUrl: '..', paths } : i === depth ? {} : { noEmit: true };
    if (i === depth) Object.assign(options, { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', allowJs: true, strict: true, noEmit: true });
    files.set(`config/tsconfig.${i}.json`, json({ ...(i < depth ? { extends: `./tsconfig.${i + 1}.json` } : {}), compilerOptions: options }));
  }

  const pkgs = plan.buckets.filter((b) => b.pkg);
  const rootPkg = { name: o.shop ? 'big-shop' : 'stress-project', version: '1.0.0', private: true, type: 'module' };
  if (o.workspace === 'npm') rootPkg.workspaces = ['packages/*'];
  if (o.workspace === 'pnpm') {
    rootPkg.dependencies = Object.fromEntries(pkgs.map((b) => [b.pkg, 'workspace:*']));
    files.set('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  }
  files.set('package.json', json(rootPkg));
  for (const b of pkgs) {
    const dir = path.posix.dirname(b.dir);
    files.set(`${dir}/package.json`, json({ name: b.pkg, version: '1.0.0', type: 'module', exports: { '.': './src/index.ts' } }));
    plan.links.push([`node_modules/${b.pkg}`, dir]);
  }
  files.set('node_modules/zod-lite/package.json', json({ name: 'zod-lite', version: '1.0.0', exports: { '.': { types: './index.d.ts', default: './index.js' } } }));
  files.set('node_modules/zod-lite/index.js', 'export const z = {};\n');
  files.set('node_modules/zod-lite/index.d.ts', 'export declare const z: {};\n');
  files.set('.gitignore', 'node_modules/\n.buckets/\n');
}

/** Source files the plan will write, apart from modules and test files. */
function overhead(plan, o, testCount) {
  const v = o.violations;
  return (
    plan.buckets.filter((b) => b.publicPlanned).length +
    testCount +
    4 + // fixtures/sample-orders.ts and three scripts
    (o.nested ? 4 : 0) +
    (v['file-unowned'] ?? 0) +
    (v['file-overlap'] ?? 0) +
    (v['public-missing'] ?? 0)
  );
}

// ------------------------------------------------------------------ entry

/**
 * Writes a project to `out` and commits it. Returns { root, files: sorted source paths, buckets, violations, head }.
 */
export function generate(options = {}) {
  const o = { ...DEFAULTS, ...options, violations: { ...(options.violations ?? {}) } };
  if (!o.out) throw new Error('generate needs an out folder');
  const root = path.resolve(o.out);
  const r = random(o.seed);
  const plan = o.shop ? shopPlan() : stressPlan(o, r);
  plan.files = new Map();
  plan.links = [];
  if (o.shop) {
    o.nested = true;
    o.violations = { 'dependency-undeclared': 1, 'import-private': 1, 'dependency-unused': 1, 'export-unused': 1, 'file-unowned': 1, ...o.violations };
  } else {
    // A bucket gets a public file when another bucket depends on it; the count is known before any module exists.
    const depended = new Set(plan.buckets.flatMap((b) => [...b.deps.keys()]));
    for (const b of plan.buckets) b.publicPlanned = depended.has(b.name);
    const tests = Math.max(1, Math.floor(o.files * 0.02));
    addStressModules(plan, o.files - overhead(plan, o, tests), r);
    plan.tests = tests;
    if (o.bigFile) {
      const host = plan.buckets.find((b) => b.modules.length > 2);
      const big = module(`${host.dir}/generated/big-table.ts`, 'bigTable', 'bigTableSize', 'BigTable');
      big.big = true;
      host.modules[host.modules.length - 1] = big;
    }
  }
  plan.tests ??= 12;
  if (o.nested) {
    const dir = o.shop ? 'packages/storefront-sdk' : 'nested/sdk';
    plan.projects.push(dir);
    nestedProject(plan.files, dir, o.shop ? '@big-shop/storefront-sdk' : '@acme/nested-sdk');
  }
  const byName = wire(plan, r);
  inject(plan, o.violations, r, byName);
  render(plan, o, r);

  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const made = new Set();
  for (const [p, text] of plan.files) {
    const full = path.join(root, p);
    const dir = path.dirname(full);
    if (!made.has(dir)) mkdirSync(dir, { recursive: true }), made.add(dir);
    writeFileSync(full, text);
  }
  for (const [link, target] of plan.links) {
    mkdirSync(path.dirname(path.join(root, link)), { recursive: true });
    symlinkSync(path.join(root, target), path.join(root, link), 'junction');
  }
  const date = '2026-09-01T10:00:00Z';
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=Stress', '-c', 'user.email=stress@example.com', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...a], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'Generated project');
  const files = [...plan.files.keys()].filter((p) => SOURCE.test(p) && !p.startsWith('node_modules/')).sort();
  return { root, files, buckets: plan.buckets.length, violations: o.violations, head: git('rev-parse', 'HEAD').trim() };
}

/** Reads command line arguments into generate() options. */
export function parseArgs(argv) {
  const o = {};
  let out;
  let preset;
  const num = (v, flag) => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 0) throw new Error(`${flag} needs a whole number, got "${v}"`);
    return x;
  };
  const flags = { '--seed': 'seed', '--files': 'files', '--buckets': 'buckets', '--fanout': 'fanout', '--chain': 'chain', '--hub': 'hub', '--exclude-every': 'excludeEvery', '--extends': 'extendsDepth', '--packages': 'packages' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) o[flags[a]] = num(argv[++i], a);
    else if (a === '--preset') preset = argv[++i];
    else if (a === '--workspace') o.workspace = argv[++i];
    else if (a === '--big-file') o.bigFile = true;
    else if (a === '--hostile-names') o.hostileNames = true;
    else if (a === '--nested') o.nested = true;
    else if (a === '--git') continue;
    else if (a === '--violations') {
      o.violations = {};
      for (const kv of (argv[++i] ?? '').split(',').filter(Boolean)) {
        const [rule, count] = kv.split('=');
        o.violations[rule] = num(count ?? '1', `--violations ${rule}`);
      }
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out = a;
  }
  if (preset !== undefined && !PRESETS[preset]) throw new Error(`unknown preset "${preset}". Presets: ${Object.keys(PRESETS).join(', ')}`);
  if (!['npm', 'pnpm', 'none', undefined].includes(o.workspace)) throw new Error('--workspace takes npm, pnpm or none');
  preset ??= o.files === undefined ? 'shop' : undefined;
  const base = preset ? PRESETS[preset] : {};
  return { ...base, ...o, violations: { ...(base.violations ?? {}), ...(o.violations ?? {}) }, out, preset };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const base = path.resolve(opts.out ?? path.join(repo, 'examples', '.tmp', 'stress'));
    if (opts.shop) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const result = generate({ ...opts, out: opts.shop ? path.join(base, 'big-shop') : base });
    const v = Object.entries(result.violations).filter(([, c]) => c > 0);
    console.log(`${result.root}: ${result.files.length} source files, ${result.buckets} buckets, commit ${result.head.slice(0, 7)}`);
    console.log(`violations: ${v.length ? v.map(([rule, c]) => `${rule} ${c}`).join(', ') : 'none'}`);
  } catch (error) {
    console.error(`stress-project: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

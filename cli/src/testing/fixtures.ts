// Deterministic generator of example inspect snapshots (examples/fixtures/snapshots/*.json). The same options always
// give the same snapshot. fixtures.test.ts compares the generated JSON with the committed files; run it with
// UPDATE_FIXTURES=1 to rewrite them.
import type { FileGroup, FileOwner, GlobCount, SnapshotBucket, SnapshotEdge, SnapshotImport, SnapshotPackage, SnapshotProject, SnapshotV2 } from '../contract/snapshot.js';
import { groupUnowned, sortAdvice, sortViolations, type Advice, type BucketImport, type Violation } from '../contract/violation.js';

export interface FixtureOptions {
  buckets: number;
  /** Files per bucket, the public index.ts included. */
  filesPerBucket: number;
  /** Files in src/legacy/, all unowned. */
  legacyFiles: number;
  seed: number;
}

export const FIXTURE_SIZES = {
  small: { buckets: 8, filesPerBucket: 6, legacyFiles: 6, seed: 1 },
  medium: { buckets: 60, filesPerBucket: 20, legacyFiles: 12, seed: 2 },
  large: { buckets: 500, filesPerBucket: 100, legacyFiles: 42, seed: 3 },
} as const satisfies Record<string, FixtureOptions>;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const SMALL_NAMES = ['app', 'api', 'billing', 'payments', 'auth', 'mail', 'db', 'log'];
const WORDS = [
  'billing', 'payments', 'auth', 'mail', 'search', 'orders', 'catalog', 'cart', 'shipping', 'tax', 'users', 'teams',
  'reports', 'audit', 'files', 'media', 'queue', 'cache', 'config', 'metrics', 'alerts', 'webhooks', 'pricing', 'invoices',
];
const PURPOSES: Record<string, string> = {
  app: 'Starts the server and wires every route',
  api: 'Public HTTP client that other projects install from npm',
  billing: 'Issues and charges invoices',
  payments: 'Talks to the payment gateway',
  auth: 'Checks sessions and permissions',
  mail: 'Renders and sends transactional email',
  db: 'Opens connections and runs SQL',
  log: 'Formats and writes application logs',
};
const VERBS = ['create', 'get', 'list', 'update', 'remove', 'sync'];
/** External modules the buckets import, with the reason a bucket declares. */
const PACKAGES: [string, string][] = [
  ['zod', 'Validates the input of every public function'],
  ['node:crypto', 'Hashes ids and signs tokens'],
  ['date-fns', 'Formats dates in reports and emails'],
];
const REASONS = ['Reads its records', 'Sends events through it', 'Needs its types', 'Calls it to validate input', 'Reports failures to it'];

const pascal = (name: string) => name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

function bucketNames(count: number): string[] {
  if (count === SMALL_NAMES.length) return [...SMALL_NAMES];
  const names = ['app'];
  for (let i = 1; i < count - 1; i++) {
    const word = WORDS[(i - 1) % WORDS.length]!;
    const round = Math.floor((i - 1) / WORDS.length);
    names.push(round === 0 ? word : `${word}-${round + 1}`);
  }
  names.push('log');
  return names;
}

interface Draft {
  name: string;
  purpose: string;
  globs: string[];
  public: string | null;
  external: string | null;
  exports: string[];
  files: string[];
  deps: Map<string, string>;
}

/** Builds one project. `prefix` is only used to vary names in the nested project. */
function buildProject(path: string, opt: FixtureOptions, nested: boolean): SnapshotProject {
  const rand = rng(opt.seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const names = nested ? ['client', 'transport', 'types'] : bucketNames(opt.buckets);
  const n = names.length;
  const external = nested ? 'client' : names[1]!;
  const drafts: Draft[] = names.map((name, i) => {
    const dir = `src/${name}`;
    const files = [`${dir}/index.ts`];
    const half = Math.ceil((opt.filesPerBucket - 1) / 2);
    for (let k = 1; k < opt.filesPerBucket; k++) {
      files.push(opt.filesPerBucket > 20 && k > half ? `${dir}/internal/module-${k}.ts` : `${dir}/module-${k}.ts`);
    }
    const exportCount = 2 + Math.floor(rand() * 3);
    return {
      name,
      purpose: PURPOSES[name] ?? `Owns the ${name.replace(/-\d+$/, '')} data and rules, part ${i}`,
      globs: [`${dir}/**`],
      public: i === 0 && !nested ? null : `${dir}/index.ts`,
      external: name === external ? 'Entry point of the npm package' : null,
      exports: VERBS.slice(0, exportCount).map((v) => `${v}${pascal(name)}`),
      files,
      deps: new Map(),
    };
  });
  const byName = new Map(drafts.map((d) => [d.name, d]));

  // dependsOn only points to a later bucket, so the config graph is acyclic.
  for (let i = 0; i < n - 1; i++) {
    const want = Math.min(n - 1 - i, 1 + Math.floor(rand() * (i === 0 ? 5 : 3)));
    const targets = new Set<number>();
    if (i > 0 && rand() < 0.6) targets.add(n - 1);
    while (targets.size < want) targets.add(i + 1 + Math.floor(rand() * (n - 1 - i)));
    for (const j of targets) drafts[i]!.deps.set(names[j]!, pick(REASONS));
  }
  for (let j = 1; j < n; j++) {
    if (drafts.some((d) => d.deps.has(names[j]!))) continue;
    drafts[Math.floor(rand() * j)]!.deps.set(names[j]!, pick(REASONS));
  }

  const violations: Violation[] = [];
  const edges = new Map<string, SnapshotEdge>();
  const toBucketImport = (i: SnapshotImport): BucketImport => ({
    file: i.file,
    line: i.line,
    target: i.target,
    names: i.names === '*' ? [] : i.names.map((name) => ({ name, typeOnly: false })),
    private: i.private,
  });
  const dependentsOf = (to: string) =>
    drafts
      .filter((d) => d.deps.has(to))
      .map((d) => ({ bucket: d.name, reason: d.deps.get(to)! }))
      .sort((a, b) => cmp(a.bucket, b.bucket))
      .slice(0, 3);
  const consumerFiles = (d: Draft) => d.files.slice(1);
  const imports = (from: Draft, to: Draft, count: number, cursor: { k: number }): SnapshotImport[] => {
    const out: SnapshotImport[] = [];
    for (let c = 0; c < count; c++) {
      const names = [to.exports[cursor.k++ % to.exports.length]!];
      if (rand() < 0.4) names.push(to.exports[cursor.k++ % to.exports.length]!);
      out.push({ file: pick(consumerFiles(from)), line: 1 + c, target: to.public!, names: [...new Set(names)].sort(cmp), private: false });
    }
    return out;
  };
  const cursors = new Map(drafts.map((d) => [d.name, { k: 0 }]));

  const candidates = drafts.filter((d) => d.name !== 'app').flatMap((d) => [...d.deps.keys()].map((to) => `${d.name}>${to}`));
  const unusedIds = new Set<string>();
  while (unusedIds.size < Math.min(candidates.length, Math.max(1, Math.floor(n / 20)))) unusedIds.add(pick(candidates));
  for (const from of drafts) {
    for (const [toName, reason] of from.deps) {
      const to = byName.get(toName)!;
      if (unusedIds.has(`${from.name}>${toName}`)) {
        edges.set(`${from.name}>${toName}`, { from: from.name, to: toName, state: 'unused', reason, imports: [] });
        violations.push({ rule: 'dependency-unused', project: path, from: from.name, to: toName, reason });
        continue;
      }
      const list = imports(from, to, 1 + Math.floor(rand() * 3), cursors.get(toName)!);
      edges.set(`${from.name}>${toName}`, { from: from.name, to: toName, state: 'used', reason, imports: list });
    }
  }
  // Undeclared edges also point to a later bucket, except the closed-bucket case below.
  const undeclaredCount = Math.max(1, Math.floor(n / 25));
  for (let u = 0, tries = 0; u < undeclaredCount && tries < 1000; tries++) {
    const i = 1 + Math.floor(rand() * (n - 2));
    const j = i + 1 + Math.floor(rand() * (n - 1 - i));
    const from = drafts[i]!;
    const to = drafts[j]!;
    if (from.deps.has(to.name) || edges.has(`${from.name}>${to.name}`)) continue;
    const list = imports(from, to, 1 + Math.floor(rand() * 2), cursors.get(to.name)!).sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
    edges.set(`${from.name}>${to.name}`, { from: from.name, to: to.name, state: 'undeclared', reason: null, imports: list });
    violations.push({
      rule: 'dependency-undeclared',
      project: path,
      from: from.name,
      to: to.name,
      fromPurpose: from.purpose,
      toPurpose: to.purpose,
      imports: list.map(toBucketImport),
      public: to.public === null ? [] : [to.public],
      dependents: dependentsOf(to.name),
      reversePath: null,
    });
    u++;
  }

  const usedEdges = [...edges.values()].filter((e) => e.state === 'used');
  if (!nested && usedEdges.length > 0) {
    // A private import and a namespace import, both inside a declared, used dependency.
    const e = usedEdges[0]!;
    const to = byName.get(e.to)!;
    const file = consumerFiles(byName.get(e.from)!)[0]!;
    const target = to.files[1]!;
    e.imports.push({ file, line: 20, target, names: ['helper'], private: true });
    violations.push({ rule: 'import-private', project: path, from: e.from, to: e.to, imports: [{ file, line: 20, target, names: [{ name: 'helper', typeOnly: false }] }], public: [to.public!] });
    const e2 = usedEdges[usedEdges.length - 1]!;
    const file2 = consumerFiles(byName.get(e2.from)!)[1]!;
    e2.imports.push({ file: file2, line: 21, target: byName.get(e2.to)!.public!, names: '*', private: false });
    violations.push({ rule: 'import-namespace', project: path, file: file2, line: 21, from: e2.from, to: e2.to, form: 'import', specifier: `../${e2.to}` });

    // An undeclared import of a file of the closed app bucket: one dependency-undeclared with a private import.
    const app = drafts[0]!;
    const from = drafts[n - 2]!;
    const file3 = consumerFiles(from)[0]!;
    const imp: SnapshotImport = { file: file3, line: 30, target: app.files[1]!, names: ['routes'], private: true };
    edges.set(`${from.name}>app`, { from: from.name, to: 'app', state: 'undeclared', reason: null, imports: [imp] });
    violations.push({
      rule: 'dependency-undeclared',
      project: path,
      from: from.name,
      to: 'app',
      fromPurpose: from.purpose,
      toPurpose: app.purpose,
      imports: [toBucketImport(imp)],
      public: [],
      dependents: [],
      reversePath: null,
    });
  }

  // Every export gets a consumer, except a few left for export-unused.
  const consumers = new Map<string, Map<string, { bucket: string; file: string; line: number }[]>>();
  for (const e of edges.values()) {
    const to = byName.get(e.to)!;
    for (const imp of e.imports) {
      if (imp.target !== to.public || imp.names === '*') continue;
      for (const name of imp.names) {
        const byExport = consumers.get(to.name) ?? new Map();
        consumers.set(to.name, byExport);
        byExport.set(name, [...(byExport.get(name) ?? []), { bucket: e.from, file: imp.file, line: imp.line }]);
      }
    }
  }
  let unusedExports = Math.max(1, Math.floor(n / 50));
  for (const d of drafts) {
    if (d.public === null) continue;
    for (const [index, name] of d.exports.entries()) {
      if (consumers.get(d.name)?.has(name)) continue;
      if (d.external !== null) continue;
      const edge = [...edges.values()].find((e) => e.to === d.name && e.imports.some((i) => i.target === d.public && i.names !== '*'));
      if (unusedExports > 0 || edge === undefined) {
        unusedExports--;
        violations.push({ rule: 'export-unused', project: path, bucket: d.name, name, public: d.public, line: index + 1 });
        continue;
      }
      const imp = edge.imports.find((i) => i.target === d.public && i.names !== '*')!;
      imp.names = [...(imp.names as string[]), name].sort(cmp);
      const byExport = consumers.get(d.name) ?? new Map();
      consumers.set(d.name, byExport);
      byExport.set(name, [{ bucket: edge.from, file: imp.file, line: imp.line }]);
    }
  }

  // Files outside buckets, and one file in two buckets.
  const owners = new Map<string, FileOwner>();
  for (const d of drafts) for (const f of d.files) owners.set(f, { state: 'bucket', bucket: d.name });
  const ignore: GlobCount[] = [];
  const extraViolations: Violation[] = [];
  const advice: Advice[] = [];
  // bucket>package -> the packages entry. Every third bucket uses one external module and declares it.
  const packages = new Map<string, SnapshotPackage>();
  drafts.forEach((d, i) => {
    if (i % 3 !== 0) return;
    const [name, reason] = PACKAGES[i % PACKAGES.length]!;
    packages.set(`${d.name}>${name}`, { name, state: 'used', reason, imports: d.files.slice(0, 1 + (i % 2)).map((file) => ({ file, line: 2, specifier: name })) });
  });
  if (!nested) {
    const scripts = ['scripts/build.ts', 'scripts/env.ts', 'scripts/release.ts'];
    const tests = drafts.slice(0, Math.min(n, 20)).map((d) => `test/${d.name}.test.ts`);
    for (const f of [...scripts, ...tests]) owners.set(f, { state: 'ignored' });
    ignore.push({ glob: 'scripts/**', count: scripts.length }, { glob: 'test/**', count: tests.length });

    const legacy = Array.from({ length: opt.legacyFiles }, (_, k) => `src/legacy/old-${k + 1}.ts`);
    for (const f of [...legacy, 'src/utils/date.ts']) owners.set(f, { state: 'unowned' });

    const broad = drafts[2]!;
    const narrow = drafts[3]!;
    const shared = `src/${broad.name}/shared/types.ts`;
    narrow.globs.push(`src/${broad.name}/shared/**`);
    owners.set(shared, { state: 'overlap', buckets: [broad.name, narrow.name].sort(cmp) });
    extraViolations.push({
      rule: 'file-overlap',
      project: path,
      file: shared,
      owners: [
        { bucket: broad.name, glob: `src/${broad.name}/**` },
        { bucket: narrow.name, glob: `src/${broad.name}/shared/**` },
      ],
    });

    const empty = drafts[4]!;
    empty.globs.push(`src/${empty.name}-old/**`);
    extraViolations.push({ rule: 'glob-empty', project: path, field: 'files', bucket: empty.name, glob: `src/${empty.name}-old/**` });

    const user = drafts[5]!;
    extraViolations.push({ rule: 'import-ignored', project: path, file: user.files[1]!, line: 2, target: 'scripts/env.ts' });
    extraViolations.push({ rule: 'import-dynamic', project: path, file: user.files[2]!, line: 9, call: 'import' });

    // An unresolved relative import, an undeclared package and a declared package that no file imports.
    extraViolations.push({ rule: 'import-unresolved', project: path, bucket: user.name, file: user.files[3]!, line: 4, specifier: './missing', kind: 'relative', pattern: null });
    const pkgUser = drafts[7]!;
    extraViolations.push({
      rule: 'package-undeclared',
      project: path,
      bucket: pkgUser.name,
      purpose: pkgUser.purpose,
      package: 'lodash',
      imports: [{ file: pkgUser.files[1]!, line: 3, specifier: 'lodash/merge' }],
      declaredBy: [],
    });
    packages.set(`${pkgUser.name}>lodash`, { name: 'lodash', state: 'undeclared', reason: null, imports: [{ file: pkgUser.files[1]!, line: 3, specifier: 'lodash/merge' }] });
    const unusedPkg = drafts[1]!;
    packages.set(`${unusedPkg.name}>left-pad`, { name: 'left-pad', state: 'unused', reason: 'Pads invoice numbers', imports: [] });
    extraViolations.push({ rule: 'package-unused', project: path, bucket: unusedPkg.name, package: 'left-pad', reason: 'Pads invoice numbers' });
    advice.push({ advice: 'reason-generic', project: path, at: ['buckets', unusedPkg.name, 'packages', 'left-pad'], text: 'Pads invoice numbers', why: 'short' });

    const loud = drafts[6]!;
    extraViolations.push({ rule: 'public-not-interface', project: path, bucket: loud.name, public: loud.public!, line: loud.exports.length + 1, kind: 'code' });
    extraViolations.push({ rule: 'project-undeclared', project: path, folder: 'tools/codegen' });

    const all = [...owners.keys()];
    const unowned = all.filter((f) => owners.get(f)!.state === 'unowned');
    extraViolations.push(...groupUnowned(path, unowned, all));
  } else {
    owners.set('src/version.ts', { state: 'unowned' });
    extraViolations.push({ rule: 'file-unowned', project: path, file: 'src/version.ts' });
  }
  violations.push(...extraViolations);

  const count = (glob: string) => {
    const dir = glob.slice(0, -3);
    return [...owners.keys()].filter((f) => f.startsWith(`${dir}/`)).length;
  };
  const buckets: SnapshotBucket[] = drafts.map((d) => ({
    name: d.name,
    purpose: d.purpose,
    files: d.globs.map((glob) => ({ glob, count: count(glob) })),
    fileCount: [...owners.values()].filter((o) => o.state === 'bucket' && o.bucket === d.name).length,
    public:
      d.public === null
        ? []
        : [
            {
              file: d.public,
              exists: true,
              exports: d.exports.map((name, index) => ({
                name,
                line: index + 1,
                typeOnly: false,
                consumers: [...(consumers.get(d.name)?.get(name) ?? [])].sort((a, b) => cmp(a.bucket, b.bucket) || cmp(a.file, b.file) || a.line - b.line),
              })),
            },
          ],
    external: d.external,
    packages: [...packages.entries()]
      .filter(([key]) => key.startsWith(`${d.name}>`))
      .map(([, pkg]) => pkg)
      .sort((a, b) => cmp(a.name, b.name)),
    dependsOn: [...d.deps.entries()]
      .sort(([a], [b]) => cmp(a, b))
      .map(([bucket, reason]) => ({ bucket, reason, imports: edges.get(`${d.name}>${bucket}`)?.imports.length ?? 0 })),
    dependents: [...edges.values()]
      .filter((e) => e.to === d.name && e.state !== 'unused')
      .map((e) => ({ bucket: e.from, names: [...new Set(e.imports.flatMap((i) => (i.names === '*' ? [] : i.names)))].sort(cmp) }))
      .sort((a, b) => cmp(a.bucket, b.bucket)),
  }));
  buckets.sort((a, b) => cmp(a.name, b.name));

  const groups = new Map<string, FileGroup>();
  for (const [file, owner] of owners) {
    const slash = file.lastIndexOf('/');
    const dir = slash < 0 ? '' : file.slice(0, slash);
    const id = `${dir}\0${JSON.stringify(owner)}`;
    const group = groups.get(id) ?? { dir, owner, names: [] };
    groups.set(id, group);
    group.names.push(file.slice(slash + 1));
  }
  const files = [...groups.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([, g]) => ({ ...g, names: g.names.sort(cmp) }));

  return {
    path,
    environment: null,
    ignore,
    projects: nested ? [] : ['packages/sdk'],
    buckets,
    edges: [...edges.values()]
      .map((e) => ({ ...e, imports: e.imports.sort((a, b) => cmp(a.file, b.file) || a.line - b.line) }))
      .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
    files,
    violations: sortViolations(violations),
    advice: sortAdvice(advice),
  };
}

export function generateSnapshot(options: FixtureOptions): SnapshotV2 {
  return {
    snapshotVersion: 2,
    projects: [buildProject('.', options, false), buildProject('packages/sdk', { buckets: 3, filesPerBucket: 4, legacyFiles: 0, seed: options.seed + 100 }, true)],
  };
}

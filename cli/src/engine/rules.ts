// Every rule of docs/reference/rules.md over one project's graph, and the advice. One pass over the edges of the files
// that a single bucket owns, then the rules that look at the whole project. config-invalid and config-newer are
// decided before this runs.
import {
  CONFIG_FILE,
  defaultExportName,
  DEPENDENTS_SHOWN,
  GENERIC_VERBS,
  groupUnowned,
  IGNORE_LARGE_SHARE,
  packageKey,
  reasonAdvice,
  UNOWNED_GROUP_MIN,
  type Advice,
  type BucketImport,
  type CycleEdge,
  type DeclaredBy,
  type ImportName,
  type ImportRef,
  type PackageImport,
  type Reexported,
  type Violation,
} from '../contract/index.js';
import type { Config } from './config.js';
import {
  F_NAMESPACE,
  F_REEXPORT,
  indexOf,
  isUnresolvedImport,
  KIND_DYNAMIC,
  KIND_MASK,
  KIND_REQUIRE,
  lowerBound,
  T_DYNAMIC,
  T_OUTSIDE,
  T_PATHS,
  T_RELATIVE,
  typeNames,
  type Graph,
} from './graph.js';
import { globTable, IGNORED, ignoredPath, makeMatcher, OVERLAP, pathOwner, UNOWNED, type Owners } from './owners.js';

export interface RuleInput {
  /** `.` or the project folder relative to the session root. */
  project: string;
  graph: Graph;
  config: Config;
  owners: Owners;
  /** Folders inside the project that hold a buckets.config.json, declared nested projects left out. */
  configs: readonly string[];
  /** Whether a folder listed in `projects` has a buckets.config.json. */
  hasConfig: (folder: string) => boolean;
}

/** One import between two buckets, for inspect. */
export interface CrossImport {
  file: string;
  line: number;
  target: string;
  names: string[] | '*';
  /** The target is not a public file of the imported bucket. */
  private: boolean;
}

export interface RuleDetail {
  /** Imports from bucket a to bucket b, keyed a * B + b. */
  pairs: Map<number, CrossImport[]>;
  /** For each public file, each name other buckets import, with who imports it. */
  consumers: Map<string, Map<string, { bucket: string; file: string; line: number }[]>>;
  /** For each bucket index, the external imports of its files by packages key. Filled by runRules. */
  packages?: Map<number, Map<string, PackageImport[]>>;
}

const byFileLine = <T extends { file: string; line: number }>(a: T, b: T) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
const byBucket = (a: DeclaredBy, b: DeclaredBy) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0);

/** What every step of runRules shares: the input, the indexes of the config, and the violations so far. */
interface RuleRun {
  input: RuleInput;
  project: string;
  g: Graph;
  config: Config;
  owners: Owners;
  owner: Int32Array;
  out: Violation[];
  /** The number of buckets. A pair of buckets a, b is the key a * B + b. */
  B: number;
  bucketId: Map<string, number>;
  /** 1 for a pair whose dependsOn entry exists. */
  declared: Uint8Array;
  /** The bucket whose public list holds each file and who owns it, -1 for any other file. */
  publicOf: Int32Array;
  /** The file index of each public file of each bucket, -1 when the file is not in the list. */
  publicIdx: number[][];
  /** Bucket pairs along a cycle: the first import of each backs its edge in the message. */
  cycleFirst: Map<number, ImportRef | null>;
  /**
   * Adds a violation unless one with the same key came first. Two statements can give the same violation (two
   * import() calls on one line, two imports of one file); only the rules that can repeat pay for the check.
   */
  once(key: string, v: Violation): void;
}

/** What the pass over every edge collects for the rules that look at the whole project. */
interface EdgeScan {
  pairCount: Int32Array;
  undeclared: Map<number, BucketImport[]>;
  privates: Map<number, ImportRef[]>;
  /** Public file index to the name ids other buckets import from it. */
  used: Map<number, Set<number>>;
  /** Bucket index to the name ids other buckets import from its private files. */
  usedPrivately: Map<number, Set<number>>;
  packages: Map<number, Map<string, PackageImport[]>>;
  /** Buckets with an unresolved import, and the buckets such an import could reach (holdAll: any bucket). */
  unresolvedFrom: Uint8Array;
  holdExports: Uint8Array;
  holdAll: boolean;
  /**
   * Buckets whose `files` globs all match no file, as after a folder move. glob-empty names the fix, so the check
   * holds back their dependency-unused, package-unused and export-unused, which would tell the agent to delete
   * correct entries.
   */
  noFiles: Uint8Array;
  ownerOfPath: ((file: string) => number) | null;
  unowned: string[];
}

export function runRules(input: RuleInput, detail?: RuleDetail): Violation[] {
  const r = prepare(input);
  const scan = scanEdges(r, detail);
  if (detail !== undefined) detail.packages = scan.packages;
  pairViolations(r, scan);
  r.config.buckets.forEach((bucket, b) => bucketViolations(r, scan, bucket, b));
  configViolations(r);
  if (scan.unowned.length > 0) {
    const g = r.g;
    // Only folders that hold an unowned file can group, so files under other top folders need no counting.
    // The list is sorted, so the files under `top/` run from the first path >= `top/` to the first >= `top0`.
    const tops = new Set(scan.unowned.map((f) => f.slice(0, f.indexOf('/') + 1)).filter((t) => t !== ''));
    const below: string[] = [];
    for (const t of [...tops].sort()) below.push(...g.files.slice(lowerBound(g.files, t), lowerBound(g.files, `${t.slice(0, -1)}0`)));
    r.out.push(...groupUnowned(r.project, scan.unowned, below, UNOWNED_GROUP_MIN, r.B === 0));
  }
  return r.out;
}

function prepare(input: RuleInput): RuleRun {
  const { project, graph: g, config, owners } = input;
  const B = config.buckets.length;
  const bucketId = new Map(config.buckets.map((b, i) => [b.name, i]));
  const declared = new Uint8Array(B * B);
  config.buckets.forEach((b, a) => {
    for (const d of Object.keys(b.dependsOn)) {
      const t = bucketId.get(d);
      if (t !== undefined) declared[a * B + t] = 1;
    }
  });
  const owner = owners.owner;
  const publicOf = new Int32Array(g.files.length).fill(-1);
  const publicIdx = config.buckets.map((b, i) =>
    b.public.map((f) => {
      const k = indexOf(g.files, f);
      if (k >= 0 && publicOf[k] === -1 && (owner[k] === i || (owner[k] === OVERLAP && (owners.overlaps.get(f) ?? []).some((x) => x.bucket === b.name)))) publicOf[k] = i;
      return k;
    }),
  );
  owners.cycles ??= configCycles(config);
  const cycleFirst = new Map<number, ImportRef | null>();
  for (const cycle of owners.cycles) cycle.forEach((from, i) => cycleFirst.set(bucketId.get(from)! * B + bucketId.get(cycle[(i + 1) % cycle.length]!)!, null));
  const out: Violation[] = [];
  const seen = new Set<string>();
  const once = (key: string, v: Violation) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  return { input, project, g, config, owners, owner, out, B, bucketId, declared, publicOf, publicIdx, cycleFirst, once };
}

/** The names edge `e` imports, with isType for those that private file `types` (-1 for none) exports as types. */
function namesOf(g: Graph, e: number, types: number): ImportName[] {
  const names: ImportName[] = [];
  if (!(g.flags[e]! & F_NAMESPACE)) for (let k = g.nameStart[e]!; k < g.nameStart[e + 1]!; k++) names.push({ name: g.strings.at(g.names[k]!), typeOnly: g.nameType[k] === 1 });
  const typeOnly = types < 0 ? undefined : typeNames(g, types);
  if (typeOnly !== undefined) for (const n of names) if (!n.typeOnly && typeOnly.includes(n.name)) n.isType = true;
  return names;
}

function addNames(g: Graph, set: Map<number, Set<number>>, key: number, e: number): void {
  let s = set.get(key);
  if (s === undefined) set.set(key, (s = new Set()));
  for (let k = g.nameStart[e]!; k < g.nameStart[e + 1]!; k++) s.add(g.names[k]!);
}

/** One pass over the edges of the files that a single bucket owns, and the file-overlap violations. */
function scanEdges(r: RuleRun, detail: RuleDetail | undefined): EdgeScan {
  const { g, owner, B } = r;
  const scan: EdgeScan = {
    pairCount: new Int32Array(B * B),
    undeclared: new Map(),
    privates: new Map(),
    used: new Map(),
    usedPrivately: new Map(),
    packages: new Map(),
    unresolvedFrom: new Uint8Array(B),
    holdExports: new Uint8Array(B),
    holdAll: false,
    noFiles: new Uint8Array(B).fill(1),
    ownerOfPath: null,
    unowned: [],
  };
  const table = globTable(r.config);
  table.bucket.forEach((b, id) => {
    if (b >= 0 && !table.negative[id] && r.owners.hits[id]! > 0) scan.noFiles[b] = 0;
  });
  for (let f = 0; f < g.files.length; f++) {
    const o = owner[f]!;
    const file = g.files[f]!;
    if (o === UNOWNED) scan.unowned.push(file);
    else if (o === OVERLAP) r.out.push({ rule: 'file-overlap', project: r.project, file, owners: r.owners.overlaps.get(file) ?? [] });
    if (o < 0) continue;
    fileEdges(r, scan, f, o, file, detail);
  }
  // The code of a bucket whose globs match nothing is likely among the unowned files, whose imports use no export.
  if (scan.unowned.length > 0 && scan.noFiles.includes(1)) scan.holdAll = true;
  return scan;
}

/** An import that does not resolve: import-unresolved, and the buckets whose export-unused it holds back. */
function unresolvedEdge(r: RuleRun, scan: EdgeScan, file: string, o: number, e: number): void {
  const { g, config } = r;
  const t = g.target[e]!;
  const specifier = g.strings.at(g.spec[e]!);
  const pattern = t === T_PATHS && g.info[e]! >= 0 ? g.strings.at(g.info[e]!) : null;
  const kind = t === T_RELATIVE ? 'relative' : t === T_PATHS ? 'paths' : 'workspace';
  r.once(`u${file}\0${specifier}`, { rule: 'import-unresolved', project: r.project, bucket: config.buckets[o]!.name, file, line: g.line[e]!, specifier, kind, pattern });
  scan.unresolvedFrom[o] = 1;
  if (t !== T_RELATIVE) scan.holdAll = true;
  else if (!scan.holdAll) {
    // The bucket of the file the specifier would name, with any extension or as a folder.
    scan.ownerOfPath ??= pathOwner(config);
    const base = normalizeJoin(file, specifier);
    const reach = base === null ? -1 : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].map(scan.ownerOfPath).find((x) => x >= 0);
    if (reach === undefined || reach < 0) scan.holdAll = true;
    else scan.holdExports[reach] = 1;
  }
}

/**
 * The edges of file `f`, owned by bucket `o`. A function of its own because a nested loop in scanEdges made V8 enter
 * optimized code for the inner loop and leave it again with a deopt at the end of every file's edges, which tripled
 * the time of the rules in a hook process.
 */
function fileEdges(r: RuleRun, scan: EdgeScan, f: number, o: number, file: string, detail: RuleDetail | undefined): void {
  const { g, owner } = r;
  for (let e = g.edgeStart[f]!; e < g.edgeStart[f + 1]!; e++) {
    const t = g.target[e]!;
    // Most edges stay in their bucket and add nothing: a hook runs this loop before V8 optimizes it, so they leave first.
    if (t >= 0 && owner[t] === o) continue;
    const line = g.line[e]!;
    if (t === T_DYNAMIC) {
      r.once(`d${file}\0${line}`, { rule: 'import-dynamic', project: r.project, file, line, call: (g.flags[e]! & KIND_MASK) === KIND_REQUIRE ? 'require' : 'import' });
    } else if (t === T_OUTSIDE) {
      const specifier = g.strings.at(g.spec[e]!);
      const key = packageKey(specifier);
      let byKey = scan.packages.get(o);
      if (byKey === undefined) scan.packages.set(o, (byKey = new Map()));
      let list = byKey.get(key);
      if (list === undefined) byKey.set(key, (list = []));
      list.push({ file, line, specifier });
    } else if (isUnresolvedImport(t)) {
      unresolvedEdge(r, scan, file, o, e);
    } else if (t >= 0) {
      const ot = owner[t]!;
      if (ot === IGNORED) r.once(`i${file}\0${g.files[t]!}`, { rule: 'import-ignored', project: r.project, file, line, target: g.files[t]! });
      else if (ot >= 0 && ot !== o) crossEdge(r, scan, file, o, e, detail);
    }
  }
}

/** An import from bucket `o` into another bucket: the pair, its names, and import-namespace. */
function crossEdge(r: RuleRun, scan: EdgeScan, file: string, o: number, e: number, detail: RuleDetail | undefined): void {
  const { g, config } = r;
  const t = g.target[e]!;
  const ot = r.owner[t]!;
  const flags = g.flags[e]!;
  const line = g.line[e]!;
  const target = g.files[t]!;
  const pk = o * r.B + ot;
  scan.pairCount[pk]!++;
  const isPrivate = r.publicOf[t] !== ot;
  const namespace = (flags & F_NAMESPACE) !== 0;
  // Only a violation, the detail and a config cycle read the names, and most imports need none: made on first use.
  let names: ImportName[] | undefined;
  const named = () => (names ??= namesOf(g, e, isPrivate ? t : -1));
  if (r.cycleFirst.get(pk) === null) r.cycleFirst.set(pk, { file, line, target, names: named() });
  if (!r.declared[pk]) {
    let list = scan.undeclared.get(pk);
    if (list === undefined) scan.undeclared.set(pk, (list = []));
    if (!list.some((i) => i.file === file && i.line === line && i.target === target)) list.push({ file, line, target, names: named(), private: isPrivate });
  } else if (isPrivate) {
    let list = scan.privates.get(pk);
    if (list === undefined) scan.privates.set(pk, (list = []));
    const known = list.find((i) => i.file === file && i.line === line && i.target === target);
    if (known === undefined) list.push({ file, line, target, names: named() });
    else for (const n of named()) if (!known.names.some((x) => x.name === n.name)) known.names.push(n);
  }
  if (detail !== undefined) {
    let list = detail.pairs.get(pk);
    if (list === undefined) detail.pairs.set(pk, (list = []));
    list.push({ file, line, target, names: namespace ? '*' : named().map((n) => n.name), private: isPrivate });
  }
  if (namespace) {
    const kind = flags & KIND_MASK;
    const form = flags & F_REEXPORT ? 'export' : kind === KIND_DYNAMIC ? 'dynamic' : kind === KIND_REQUIRE ? 'require' : 'import';
    const specifier = g.strings.at(g.spec[e]!);
    r.once(`n${file}\0${line}\0${specifier}`, { rule: 'import-namespace', project: r.project, file, line, from: config.buckets[o]!.name, to: config.buckets[ot]!.name, form, specifier });
    return;
  }
  if (isPrivate) {
    addNames(g, scan.usedPrivately, ot, e);
    return;
  }
  addNames(g, scan.used, t, e);
  if (detail === undefined) return;
  let byName = detail.consumers.get(target);
  if (byName === undefined) detail.consumers.set(target, (byName = new Map()));
  for (const n of named()) {
    let list = byName.get(n.name);
    if (list === undefined) byName.set(n.name, (list = []));
    list.push({ bucket: config.buckets[o]!.name, file, line });
  }
}

/**
 * The names of `imports` that a public file of bucket `b` re-exports from the same target, as `{ reexported }`, or {}
 * when there are none. A name counts when the public file has a named re-export of it from the target and exports
 * that name, or for `default`, its defaultExportName.
 */
function reexportedNames(r: RuleRun, b: number, imports: readonly ImportRef[]): { reexported?: Reexported[] } {
  const { g } = r;
  /** Target file to the names the public files re-export from it. */
  const have = new Map<string, Set<string>>();
  for (const pi of r.publicIdx[b]!) {
    if (pi < 0) continue;
    const exported = new Set(g.exports.get(g.files[pi]!)?.names.map((x) => x.name));
    for (let e = g.edgeStart[pi]!; e < g.edgeStart[pi + 1]!; e++) {
      const t = g.target[e]!;
      if (t < 0 || !(g.flags[e]! & F_REEXPORT) || g.flags[e]! & F_NAMESPACE) continue;
      let names = have.get(g.files[t]!);
      if (names === undefined) have.set(g.files[t]!, (names = new Set()));
      for (let k = g.nameStart[e]!; k < g.nameStart[e + 1]!; k++) {
        const name = g.strings.at(g.names[k]!);
        if (name === 'default' ? exported.has(defaultExportName(g.files[t]!)) : exported.has(name)) names.add(name);
      }
    }
  }
  const found: Reexported[] = [];
  for (const i of imports) {
    for (const n of i.names) {
      if (have.get(i.target)?.has(n.name) && !found.some((x) => x.target === i.target && x.name === n.name)) found.push({ target: i.target, name: n.name });
    }
  }
  found.sort((x, y) => (x.target < y.target ? -1 : x.target > y.target ? 1 : x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return found.length === 0 ? {} : { reexported: found };
}

/** import-private and dependency-undeclared, one per pair of buckets. */
function pairViolations(r: RuleRun, scan: EdgeScan): void {
  const { config, B, bucketId, project, out } = r;
  for (const [pk, imports] of scan.privates) {
    const to = config.buckets[pk % B]!;
    out.push({ rule: 'import-private', project, from: config.buckets[Math.floor(pk / B)]!.name, to: to.name, imports: imports.sort(byFileLine), public: [...to.public], ...reexportedNames(r, pk % B, imports) });
  }
  // dependents and reversePath of dependency-undeclared
  const dependentsOf = new Map<string, DeclaredBy[]>();
  for (const b of config.buckets) {
    for (const [dep, reason] of Object.entries(b.dependsOn)) {
      let list = dependentsOf.get(dep);
      if (list === undefined) dependentsOf.set(dep, (list = []));
      list.push({ bucket: b.name, reason });
    }
  }
  for (const list of dependentsOf.values()) list.sort(byBucket);
  const parentsFrom = new Map<string, Map<string, string>>();
  // Sorted once: a config edit can leave dozens of undeclared pairs, each a search over every bucket.
  const sortedDeps: (string[] | undefined)[] = [];
  const pathBack = (start: string, end: string): string[] | null => {
    let parents = parentsFrom.get(start);
    if (parents === undefined) {
      // Breadth first over dependsOn, names in order: the first path found is the shortest, ties broken by name.
      parents = new Map([[start, '']]);
      const queue = [start];
      for (let k = 0; k < queue.length; k++) {
        const node = queue[k]!;
        const id = bucketId.get(node)!;
        for (const next of (sortedDeps[id] ??= Object.keys(config.buckets[id]!.dependsOn).sort())) {
          if (!bucketId.has(next) || parents.has(next)) continue;
          parents.set(next, node);
          queue.push(next);
        }
      }
      parentsFrom.set(start, parents);
    }
    if (!parents.has(end)) return null;
    const path: string[] = [];
    for (let node = end; node !== ''; node = parents.get(node)!) path.unshift(node);
    return path;
  };
  for (const [pk, imports] of scan.undeclared) {
    const from = config.buckets[Math.floor(pk / B)]!;
    const to = config.buckets[pk % B]!;
    const reversePath = pathBack(to.name, from.name);
    // The opposite pair undeclared too: each message alone offers to declare its direction, and both make a cycle.
    const reverseUndeclared = reversePath === null && scan.undeclared.has((pk % B) * B + Math.floor(pk / B));
    out.push({
      rule: 'dependency-undeclared',
      project,
      from: from.name,
      to: to.name,
      fromPurpose: from.purpose,
      toPurpose: to.purpose,
      imports: imports.sort(byFileLine),
      public: [...to.public],
      ...reexportedNames(r, pk % B, imports.filter((i) => i.private)),
      dependents: (dependentsOf.get(to.name) ?? []).slice(0, DEPENDENTS_SHOWN),
      reversePath,
      ...(reverseUndeclared ? { reverseUndeclared: true as const } : {}),
    });
  }
}

/** The rules of one bucket: dependency-unused, its packages and its public files. */
function bucketViolations(r: RuleRun, scan: EdgeScan, bucket: Config['buckets'][number], b: number): void {
  const { config, B, bucketId, project, out } = r;
  if (!scan.unresolvedFrom[b] && !scan.noFiles[b]) {
    for (const dep in bucket.dependsOn) {
      const t = bucketId.get(dep);
      if (t !== undefined && t !== b && scan.pairCount[b * B + t] === 0) out.push({ rule: 'dependency-unused', project, from: bucket.name, to: dep, reason: bucket.dependsOn[dep]! });
    }
  }
  const imported = scan.packages.get(b);
  for (const [key, imports] of imported ?? []) {
    if (key in bucket.packages) continue;
    const declaredBy = config.buckets.filter((x) => x !== bucket && key in x.packages).map((x) => ({ bucket: x.name, reason: x.packages[key]! }));
    out.push({ rule: 'package-undeclared', project, bucket: bucket.name, purpose: bucket.purpose, package: key, imports: imports.sort(byFileLine), declaredBy: declaredBy.sort(byBucket).slice(0, DEPENDENTS_SHOWN) });
  }
  for (const [key, reason] of Object.entries(bucket.packages)) {
    if (!scan.noFiles[b] && !imported?.has(key)) out.push({ rule: 'package-unused', project, bucket: bucket.name, package: key, reason });
  }
  bucket.public.forEach((pub, k) => publicViolations(r, scan, bucket, b, pub, r.publicIdx[b]![k]!));
}

/** public-missing, public-not-interface and export-unused of one public file `pub`, at file index `pi`. */
function publicViolations(r: RuleRun, scan: EdgeScan, bucket: Config['buckets'][number], b: number, pub: string, pi: number): void {
  const { g, config, owner, project, out } = r;
  if (pi < 0) {
    out.push({ rule: 'public-missing', project, bucket: bucket.name, public: pub, state: 'not-found', owner: null });
    return;
  }
  if (r.publicOf[pi] !== b) {
    const po = owner[pi]!;
    const overlap = po === OVERLAP ? (r.owners.overlaps.get(pub) ?? []) : [];
    const state = po === IGNORED ? 'ignored' : po === UNOWNED ? 'unowned' : 'other-bucket';
    const other = po >= 0 ? config.buckets[po]!.name : (overlap.find((x) => x.bucket !== bucket.name)?.bucket ?? null);
    // A file another bucket lists first: it is that bucket's public file, whoever owns it.
    out.push({ rule: 'public-missing', project, bucket: bucket.name, public: pub, state, owner: state === 'other-bucket' ? other : null });
    return;
  }
  const info = g.exports.get(pub);
  if (info !== undefined && info.codeLine > 0) out.push({ rule: 'public-not-interface', project, bucket: bucket.name, public: pub, line: info.codeLine, kind: 'code' });
  reexportViolations(r, bucket, b, pub, pi);
  if (bucket.external !== null || info === undefined || scan.holdAll || scan.holdExports[b] || scan.noFiles[b]) return;
  const usedNames = new Set<string>();
  for (const id of scan.used.get(pi) ?? []) usedNames.add(g.strings.at(id));
  for (const id of scan.usedPrivately.get(b) ?? []) usedNames.add(g.strings.at(id));
  for (const x of info.names) {
    if (!usedNames.has(x.name)) r.once(`e${pub}\0${x.name}`, { rule: 'export-unused', project, bucket: bucket.name, name: x.name, public: pub, line: x.line });
  }
}

/** public-not-interface for the re-exports of a public file: export * and re-exports from another bucket. */
function reexportViolations(r: RuleRun, bucket: Config['buckets'][number], b: number, pub: string, pi: number): void {
  const { g, config, owner, project } = r;
  for (let e = g.edgeStart[pi]!; e < g.edgeStart[pi + 1]!; e++) {
    const flags = g.flags[e]!;
    if (!(flags & F_REEXPORT)) continue;
    const line = g.line[e]!;
    if (flags & F_NAMESPACE) r.once(`s${pub}\0${line}\0${g.strings.at(g.spec[e]!)}`, { rule: 'public-not-interface', project, bucket: bucket.name, public: pub, line, kind: 'export-star', specifier: g.strings.at(g.spec[e]!) });
    const t = g.target[e]!;
    const ot = t >= 0 ? owner[t]! : -1;
    if (ot < 0 || ot === b) continue;
    const sourceBucket = config.buckets[ot]!.name;
    // An external bucket is the entry of a library: it may re-export by name what its dependencies offer.
    if (bucket.external !== null && sourceBucket in bucket.dependsOn && !(flags & F_NAMESPACE)) continue;
    r.once(`f${pub}\0${g.files[t]!}`, { rule: 'public-not-interface', project, bucket: bucket.name, public: pub, line, kind: 'foreign-reexport', source: g.files[t]!, sourceBucket });
  }
}

/** The rules of the config as a whole: glob-empty, config-cycle and project-undeclared. */
function configViolations(r: RuleRun): void {
  const { config, owners, input, project, out, bucketId, B } = r;
  const table = globTable(config);
  table.globs.forEach((glob, id) => {
    if (owners.hits[id] !== 0) return;
    const b = table.bucket[id]!;
    if (b < 0) out.push({ rule: 'glob-empty', project, field: 'ignore', bucket: null, glob });
    else out.push({ rule: 'glob-empty', project, field: 'files', bucket: config.buckets[b]!.name, glob });
  });
  for (const p of config.projects) if (!input.hasConfig(p.folder)) out.push({ rule: 'glob-empty', project, field: 'projects', bucket: null, glob: p.written });

  // config-cycle: the cycles depend only on the config, so the owners (cached per config) keep them
  for (const cycle of owners.cycles ?? []) {
    const edges: CycleEdge[] = cycle.map((from, i) => {
      const to = cycle[(i + 1) % cycle.length]!;
      const b = config.buckets[bucketId.get(from)!]!;
      return { from, to, reason: b.dependsOn[to]!, import: r.cycleFirst.get(bucketId.get(from)! * B + bucketId.get(to)!) ?? null };
    });
    out.push({ rule: 'config-cycle', project, cycle, edges });
  }

  // project-undeclared: a nested config found inside the project, outside the declared projects and outside ignore
  const declaredProjects = config.projects.map((p) => p.folder);
  let ignored: ((file: string) => boolean) | null = null;
  for (const folder of input.configs) {
    if (folder === '' || declaredProjects.some((p) => folder === p || folder.startsWith(`${p}/`))) continue;
    ignored ??= ignoredPath(config);
    if (ignored(`${folder}/${CONFIG_FILE}`)) continue;
    out.push({ rule: 'project-undeclared', project, folder });
  }
}

/** The project path a relative specifier of `file` names, without extension handling, or null when it leaves the project. */
function normalizeJoin(file: string, specifier: string): string | null {
  const parts = file.split('/').slice(0, -1);
  for (const seg of specifier.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A path that names a test, script, fixture or example: what ignore is for, so ignore-large does not count it. */
const TOOLING_PATH = /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|specs?|fixtures?|examples?|e2e|scripts?|bench(marks?)?)\/|(^|\/)test[-_][^/]*$|\.(test|spec|bench|stories)\.[^/]+$/;

/** The ignored files that `glob` matches, without the paths of tests, scripts, fixtures and examples. */
function productHits(glob: string, files: readonly string[], owners: Owners): number {
  const match = makeMatcher([glob]);
  let n = 0;
  files.forEach((file, i) => {
    if (owners.owner[i] === IGNORED && !TOOLING_PATH.test(file) && match(file).length > 0) n++;
  });
  return n;
}

/** Words that say nothing about what a bucket does, such as the "does" and "job" of "Does the b00 job". */
const PURPOSE_FILLER = new Set([
  ...['a', 'an', 'and', 'the', 'it', 'its', 'on', 'to', 'for', 'of', 'all', 'some', 'other', 'various', 'misc'],
  ...['does', 'do', 'job', 'jobs', 'stuff', 'things', 'thing', 'handles', 'handle', 'code', 'logic', 'work', 'works', 'everything', 'related'],
  ...GENERIC_VERBS.flatMap((v) => v.split(' ')),
]);

/**
 * True when a purpose holds only bucket names and PURPOSE_FILLER, such as "Does the b00 job" or "Handles billing
 * stuff", which reasonAdvice passes because "does" and "job" are no generic verbs of a reason.
 */
export function fillerOnly(text: string, names: ReadonlySet<string>): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}@:/._-]+/gu) ?? [];
  return words.every((w) => PURPOSE_FILLER.has(w) || names.has(w.replace(/[.:]+$/, '')));
}

/**
 * The advice of a valid config: every purpose and reason reasonAdvice flags, every purpose fillerOnly flags, and every ignore glob that matches more
 * than IGNORE_LARGE_SHARE of the files without counting tests, scripts, fixtures and examples. `files` are the files
 * of `owners`, so every file is a source file and `files.length` is the total.
 */
export function computeAdvice(project: string, config: Config, owners: Owners, files: readonly string[]): Advice[] {
  const total = files.length;
  // The reasons depend only on the config, so the owners (cached per config) keep them: 18,000 reasons take 20 ms.
  if (owners.reasons === undefined) {
    const reasons: NonNullable<Owners['reasons']> = [];
    const names = config.buckets.map((b) => b.name);
    const nameSet = new Set(names);
    const check = (text: string, at: (string | number)[], purpose = false) => {
      const why = reasonAdvice(text, names) ?? (purpose && fillerOnly(text, nameSet) ? 'generic' : null);
      if (why !== null) reasons.push({ at, text, why });
    };
    for (const b of config.buckets) {
      check(b.purpose, ['buckets', b.name, 'purpose'], true);
      for (const [dep, reason] of Object.entries(b.dependsOn)) check(reason, ['buckets', b.name, 'dependsOn', dep]);
      for (const [pkg, reason] of Object.entries(b.packages)) check(reason, ['buckets', b.name, 'packages', pkg]);
      if (b.external !== null) check(b.external, ['buckets', b.name, 'external']);
    }
    owners.reasons = reasons;
  }
  const out: Advice[] = owners.reasons.map((r) => ({ advice: 'reason-generic', project, ...r }));
  const table = globTable(config);
  let i = 0;
  table.globs.forEach((glob, id) => {
    if (table.bucket[id] !== -1) return;
    const at = i++;
    const count = owners.hits[id]!;
    if (table.negative[id] || total === 0 || count / total <= IGNORE_LARGE_SHARE) return;
    // Only the large globs pay for the second pass over the files.
    if (productHits(glob, files, owners) / total > IGNORE_LARGE_SHARE) out.push({ advice: 'ignore-large', project, at: ['ignore', at], glob, count, total });
  });
  return out;
}

/** One cycle per strongly connected component of dependsOn (and per bucket that depends on itself), from its first name. */
export function configCycles(config: Config): string[][] {
  const bucketId = new Set(config.buckets.map((b) => b.name));
  const cycles: string[][] = [];
  const adjacency = new Map(config.buckets.map((b) => [b.name, new Set(Object.keys(b.dependsOn).filter((d) => bucketId.has(d)))]));
  for (const b of config.buckets) if (adjacency.get(b.name)!.has(b.name)) cycles.push([b.name]);
  for (const component of cyclicComponents(config.buckets.map((b) => b.name), adjacency)) {
    // The shortest cycle through the first name: a breadth-first search from it, inside the component, up to the
    // first bucket that depends on it again.
    const start = component[0]!;
    const allowed = new Set(component);
    const previous = new Map<string, string>();
    const queue = [start];
    let end: string | null = null;
    for (let k = 0; k < queue.length && end === null; k++) {
      const node = queue[k]!;
      for (const next of [...adjacency.get(node)!].sort()) {
        if (next === start && node !== start) {
          end = node;
          break;
        }
        if (!allowed.has(next) || next === start || previous.has(next)) continue;
        previous.set(next, node);
        queue.push(next);
      }
    }
    if (end === null) continue;
    const cycle: string[] = [];
    for (let node: string | undefined = end; node !== undefined && node !== start; node = previous.get(node)) cycle.unshift(node);
    cycles.push([start, ...cycle]);
  }
  return cycles;
}

/** The project files a violation names, for recheck. Config rules name buckets.config.json. */
export function violationFiles(v: Violation): string[] {
  switch (v.rule) {
    case 'dependency-undeclared':
      return [...new Set(v.imports.flatMap((i) => (i.private ? [i.file, i.target] : [i.file])))];
    case 'import-private':
      return [...new Set(v.imports.flatMap((i) => [i.file, i.target]))];
    case 'import-ignored':
      return [v.file, v.target];
    case 'import-unresolved':
    case 'import-dynamic':
    case 'import-namespace':
      return [v.file];
    case 'package-undeclared':
      return [...new Set(v.imports.map((i) => i.file))];
    case 'file-unowned':
      return 'file' in v ? [v.file] : [];
    case 'file-overlap':
      return [v.file];
    case 'public-missing':
    case 'public-not-interface':
    case 'export-unused':
      return [v.public];
    case 'project-undeclared':
      return [`${v.folder}/${CONFIG_FILE}`];
    default:
      return [];
  }
}

/** Strongly connected components with more than one node (Tarjan). */
function cyclicComponents(nodes: string[], adjacency: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];

  const strongConnect = (v: string): void => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) result.push(component.sort());
    }
  };

  for (const node of nodes) if (!indices.has(node)) strongConnect(node);
  return result;
}

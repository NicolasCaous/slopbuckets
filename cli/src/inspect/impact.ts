// Impact simulations of `buckets inspect`, computed in memory from the snapshot (and, for the list of symbols a bucket
// could offer, from its `_/` files). Nothing is written. Three questions:
//
// - bucket: what breaks if a bucket disappeared, with its sub-buckets and the projects nested in it
// - path: which DMZ files a consumer bucket needs to use a symbol, level by level, with the lines to copy
// - external: who is affected when a symbol that a `.external.ts` publishes changes
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXTERNAL, PARENT, SELF } from '../core/dmz-path.js';
import { listFilesRecursive } from '../core/fs-walk.js';
import { LINKS_DIR } from '../core/links.js';
import { splitBucketPath } from '../core/paths.js';
import { describeDmzPath } from '../web/refresh-page.js';
import { exportedNames, type ContractSnapshot, type InspectSnapshot, type LinkSnapshot, type ProjectSnapshot } from './snapshot.js';

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function rootOf(project: ProjectSnapshot): string {
  return project.config?.root ?? 'root';
}

function bucketOfFile(project: ProjectSnapshot, file: string): string | null {
  return splitBucketPath(rootOf(project), file)?.bucket ?? null;
}

// ---- bucket removal ----

export interface ImpactFile {
  file: string;
  line: number;
  bucket: string;
  symbols: string[];
  /** The DMZ file the import goes through. */
  via: string;
}

export interface LinkConsumer {
  project: string;
  link: string;
  name: string;
  mode: LinkSnapshot['mode'];
  state: LinkSnapshot['state'];
  /** Code of the consuming project that imports the link, with the names it uses. */
  files: { file: string; line: number; names: string[] }[];
}

export interface BucketImpact {
  project: string;
  bucket: string;
  /** The bucket and every bucket below it, which go with the folder. */
  removed: string[];
  /** Projects nested in the removed buckets, which go too. */
  nested: string[];
  contracts: { file: string; owner: string; provider: string; consumer: string; reason: 'removed' | 'broken'; symbols: string[] }[];
  /** Symbols declared in the removed buckets that some DMZ file passes on. */
  symbols: { name: string; origin: string; declaredIn: string; carriers: string[] }[];
  /** Files of the remaining buckets that import a symbol that would be gone. */
  files: ImpactFile[];
  /** Remaining buckets whose code would no longer compile. */
  buckets: string[];
  /** Published files that would be gone or broken, and the projects that link them. */
  external: { project: string; file: string; reason: 'contract' | 'project'; symbols: string[]; consumers: LinkConsumer[] }[];
}

function consumersOf(snapshot: InspectSnapshot, publisher: ProjectSnapshot, file: string, names: string[] | null): LinkConsumer[] {
  const surface = publisher.external.find((e) => e.file === file);
  const out: LinkConsumer[] = [];
  for (const c of surface?.consumers ?? []) {
    const project = snapshot.projects.find((p) => p.path === c.project);
    const link = project?.links.find((l) => l.path === c.link);
    if (!project || !link) continue;
    const files = link.usedBy.filter((u) => names === null || u.names.length === 0 || u.names.some((n) => names.includes(n)));
    out.push({ project: project.path, link: link.path, name: link.name, mode: link.mode, state: link.state, files });
  }
  return out;
}

/** What breaks if `bucket` of `projectPath` disappeared. Null when the snapshot has no such bucket. */
export function bucketImpact(snapshot: InspectSnapshot, projectPath: string, bucket: string): BucketImpact | null {
  const project = snapshot.projects.find((p) => p.path === projectPath);
  if (!project || !project.buckets.some((b) => b.path === bucket)) return null;
  const removed = new Set(project.buckets.filter((b) => b.path === bucket || b.path.startsWith(`${bucket}/`)).map((b) => b.path));
  const gone = (file: string): boolean => {
    const owner = bucketOfFile(project, file);
    return owner !== null && removed.has(owner);
  };
  const contracts: BucketImpact['contracts'] = [];
  const brokenSymbols = new Map<string, string[]>();
  const symbols = new Map<string, BucketImpact['symbols'][number]>();
  for (const c of project.contracts) {
    const lost = removed.has(c.owner) ? c.symbols : c.symbols.filter((s) => (s.origin !== null && removed.has(s.origin)) || s.chain.some(gone) || (c.providerBucket !== null && removed.has(c.providerBucket)));
    for (const s of c.symbols) {
      if (s.origin === null || !removed.has(s.origin) || s.declaredIn === null) continue;
      const key = `${s.declaredIn}\0${s.name}`;
      if (!symbols.has(key)) symbols.set(key, { name: s.name, origin: s.origin, declaredIn: s.declaredIn, carriers: [] });
      symbols.get(key)!.carriers.push(c.file);
    }
    if (lost.length === 0) continue;
    contracts.push({ file: c.file, owner: c.owner, provider: c.provider, consumer: c.consumer, reason: removed.has(c.owner) ? 'removed' : 'broken', symbols: lost.map((s) => s.name) });
    brokenSymbols.set(c.file, lost.map((s) => s.name));
  }
  const files = new Map<string, ImpactFile>();
  const addFile = (file: string, line: number, owner: string, symbol: string, via: string): void => {
    if (removed.has(owner)) return;
    const key = `${file}:${line}`;
    if (!files.has(key)) files.set(key, { file, line, bucket: owner, symbols: [], via });
    const entry = files.get(key)!;
    if (!entry.symbols.includes(symbol)) entry.symbols.push(symbol);
  };
  for (const c of project.contracts) {
    const lost = brokenSymbols.get(c.file);
    if (!lost) continue;
    for (const s of c.symbols) if (lost.includes(s.name)) for (const imp of s.importers) addFile(imp.file, imp.line, imp.bucket, s.name, c.file);
  }
  for (const edge of project.imports) {
    if (!removed.has(edge.to) || removed.has(edge.from)) continue;
    for (const f of edge.files) addFile(f.file, f.line, edge.from, f.symbol, f.via);
  }
  // Imports that already break the rules by reaching into the bucket's code break for good too.
  for (const v of project.violations) {
    if (v.kind !== 'forbidden' || !v.target?.bucket || !removed.has(v.target.bucket) || v.bucket === null || v.line === undefined) continue;
    addFile(v.file, v.line, v.bucket, '(forbidden import)', v.target.file);
  }
  const nested = project.buckets.filter((b) => removed.has(b.path)).flatMap((b) => b.projects);
  const external: BucketImpact['external'] = [];
  for (const c of contracts) {
    if (c.consumer !== EXTERNAL) continue;
    external.push({ project: project.path, file: c.file, reason: 'contract', symbols: c.symbols, consumers: consumersOf(snapshot, project, c.file, c.symbols) });
  }
  for (const p of nested) {
    for (const inner of snapshot.projects.filter((x) => x.path === p || x.path.startsWith(`${p}/`))) {
      for (const e of inner.external) {
        const consumers = consumersOf(snapshot, inner, e.file, null).filter((x) => x.project !== p && !x.project.startsWith(`${p}/`));
        external.push({ project: inner.path, file: e.file, reason: 'project', symbols: e.symbols.map((s) => s.name), consumers });
      }
    }
  }
  const list = [...files.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  for (const f of list) f.symbols.sort();
  return {
    project: project.path,
    bucket,
    removed: sorted(removed),
    nested: sorted(nested),
    contracts,
    symbols: [...symbols.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.declaredIn < b.declaredIn ? -1 : 1)),
    files: list,
    buckets: sorted(list.map((f) => f.bucket)),
    external,
  };
}

// ---- the DMZ path from a symbol to a consumer ----

export interface PathStep {
  /** Level of the bucket whose `dmz/` holds the file (0 for the root bucket). */
  level: number;
  owner: string;
  file: string;
  /** `up` exposes the symbol to the level above, `across` passes it between siblings, `down` hands it to a child. */
  role: 'up' | 'across' | 'down' | 'self' | 'to-parent';
  /** The file this step re-exports from. */
  from: string;
  /** The re-export line to add. */
  line: string;
  /** `present`: the file already passes this symbol on. `add`: the file exists, add the line. `create`: a new file. `conflict`: the file passes another symbol with this name. */
  status: 'present' | 'add' | 'create' | 'conflict';
  about: string | null;
}

export interface SymbolPath {
  project: string;
  symbol: string;
  typeOnly: boolean;
  origin: string;
  declaredIn: string;
  consumer: string;
  steps: PathStep[];
  /** The import the consumer's code writes, and the file it imports from. */
  importLine: string;
  importFrom: string;
  /** Set when the import would close a cycle of the bucket graph: the buckets, the consumer first and last. */
  cycle: string[] | null;
  /** A note for special cases, such as a symbol of the consumer's own code. */
  note: string | null;
}

export interface PathRequest {
  project: string;
  symbol: string;
  /** The `_/` file that declares the symbol. */
  declaredIn: string;
  consumer: string;
  typeOnly?: boolean;
}

/** The alias specifier of a project file, without its extension. */
export function specifierOf(project: ProjectSnapshot, file: string): string {
  const root = rootOf(project);
  const alias = project.config?.alias ?? '@root';
  let rest = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  const dot = rest.lastIndexOf('.');
  const slash = rest.lastIndexOf('/');
  if (dot > slash + 1) rest = rest.slice(0, dot);
  if (rest.endsWith('.d')) rest = rest.slice(0, -2);
  return `${alias}/${rest}`;
}

function dmzExtension(project: ProjectSnapshot): string {
  const sample = project.contracts[0]?.file;
  const m = sample ? /(\.[^./]+)$/.exec(sample) : null;
  return m ? m[1]! : '.ts';
}

/** The DMZ files `consumer` needs to use a symbol declared in another bucket, following the DMZ tables of the SPEC. */
export function symbolPath(snapshot: InspectSnapshot, request: PathRequest): SymbolPath | { problem: string } {
  const project = snapshot.projects.find((p) => p.path === request.project);
  if (!project) return { problem: `No project ${request.project}.` };
  const root = rootOf(project);
  const split = splitBucketPath(root, request.declaredIn);
  if (!split || split.area !== '_' || split.rest === '') return { problem: `${request.declaredIn} is not a file in the _/ folder of a bucket. Pick a symbol from the list.` };
  const origin = split.bucket;
  const byPath = new Map(project.buckets.map((b) => [b.path, b]));
  if (!byPath.has(origin)) return { problem: `${origin} is not a bucket of ${project.name}.` };
  if (!byPath.has(request.consumer)) return { problem: `${request.consumer} is not a bucket of ${project.name}. Pick a consumer from the list.` };
  const consumer = request.consumer;
  const name = (b: string) => b.slice(b.lastIndexOf('/') + 1);
  const ancestry = (b: string): string[] => {
    const out: string[] = [];
    let cur: string | null = b;
    while (cur !== null) {
      out.unshift(cur);
      cur = byPath.get(cur)?.parent ?? null;
    }
    return out;
  };
  const up = ancestry(origin);
  const downChain = ancestry(consumer);
  let lca = root;
  for (let i = 0; i < Math.min(up.length, downChain.length) && up[i] === downChain[i]; i++) lca = up[i]!;
  const childToward = (from: string, target: string): string => downChain.find((b) => byPath.get(b)?.parent === from) ?? ancestry(target).find((b) => byPath.get(b)?.parent === from)!;
  const typeOnly = request.typeOnly ?? false;
  const ext = dmzExtension(project);
  const level = (b: string) => byPath.get(b)?.level ?? 0;
  const keyword = typeOnly ? 'export type' : 'export';
  const steps: PathStep[] = [];
  let src = request.declaredIn;
  const step = (owner: string, file: string, role: PathStep['role']): void => {
    const contract: ContractSnapshot | undefined = project.contracts.find((c) => c.file === file);
    const same = contract?.symbols.find((s) => s.name === request.symbol);
    const status: PathStep['status'] = !contract ? 'create' : !same ? 'add' : same.declaredIn === request.declaredIn ? 'present' : 'conflict';
    steps.push({ level: level(owner), owner, file, role, from: src, line: `${keyword} { ${request.symbol} } from '${specifierOf(project, src)}';`, status, about: describeDmzPath(file) });
    src = file;
  };
  let note: string | null = null;
  if (origin === consumer) {
    note = `${request.symbol} is declared in the consumer's own _/ folder, so no DMZ file is needed: import it from its file.`;
  } else {
    if (origin !== lca) {
      let x = origin;
      while (byPath.get(x)?.parent !== lca) {
        const p = byPath.get(x)!.parent!;
        step(p, `${p}/dmz/${name(x)}/${PARENT}${ext}`, 'up');
        x = p;
      }
      if (consumer === lca) step(lca, `${lca}/dmz/${name(x)}/${SELF}${ext}`, 'to-parent');
      else step(lca, `${lca}/dmz/${name(x)}/${name(childToward(lca, consumer))}${ext}`, 'across');
    } else {
      step(lca, `${lca}/dmz/${SELF}/${name(childToward(lca, consumer))}${ext}`, 'self');
    }
    if (consumer !== lca) {
      let y = childToward(lca, consumer);
      while (y !== consumer) {
        const next = childToward(y, consumer);
        step(y, `${y}/dmz/${PARENT}/${name(next)}${ext}`, 'down');
        y = next;
      }
    }
  }
  const importFrom = src;
  const importLine = `${typeOnly ? 'import type' : 'import'} { ${request.symbol} } from '${specifierOf(project, importFrom)}';`;
  return { project: project.path, symbol: request.symbol, typeOnly, origin, declaredIn: request.declaredIn, consumer, steps, importLine, importFrom, cycle: origin === consumer ? null : cycleThrough(project, consumer, origin), note };
}

/** The cycle that an edge from `from` to `to` would close, as buckets from `from` back to `from`, or null. */
export function cycleThrough(project: ProjectSnapshot, from: string, to: string): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of project.imports) {
    if (!next.has(e.from)) next.set(e.from, []);
    next.get(e.from)!.push(e.to);
  }
  const prev = new Map<string, string>();
  const queue = [to];
  const seen = new Set([to]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === from) {
      const pathBack = [from];
      let at = from;
      while (at !== to) {
        at = prev.get(at)!;
        pathBack.unshift(at);
      }
      return [from, ...pathBack];
    }
    for (const n of next.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      queue.push(n);
    }
  }
  return null;
}

/** A symbol a bucket could offer: an export of a file in its `_/` folder. */
export interface CodeExport {
  bucket: string;
  file: string;
  name: string;
  typeOnly: boolean;
}

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MAX_CODE_EXPORTS = 3000;

/**
 * Exports of the `_/` files of every bucket, read line by line like the link folders are. Links, nested projects,
 * tests and compiler output are left out. The list is for picking a symbol, so a missed export only hides a choice.
 */
export function codeExports(project: ProjectSnapshot): CodeExport[] {
  const out: CodeExport[] = [];
  for (const bucket of project.buckets) {
    const codeDir = path.join(project.dir, bucket.path, '_');
    let files: string[];
    try {
      files = listFilesRecursive(codeDir, { skipDir: (rel) => rel === LINKS_DIR }).files;
    } catch {
      continue;
    }
    for (const rel of files) {
      if (!CODE_FILE.test(rel) || /\.(?:spec|test)\.[^./]+$/.test(rel) || (rel.endsWith('.d.ts') && files.includes(rel.replace(/\.d\.ts$/, '.ts')))) continue;
      let text: string;
      try {
        text = readFileSync(path.join(codeDir, rel), 'utf8');
      } catch {
        continue;
      }
      if (text.length > 400_000) continue;
      for (const e of exportedNames(text.split(/\r?\n/).filter((l) => !/\bfrom\s+['"]/.test(l)).join('\n'))) {
        out.push({ bucket: bucket.path, file: `${bucket.path}/_/${rel}`, name: e.name, typeOnly: e.typeOnly });
        if (out.length >= MAX_CODE_EXPORTS) return out;
      }
    }
  }
  return out;
}

// ---- a change to a published symbol ----

export interface ExternalImpact {
  project: string;
  file: string;
  symbol: string;
  origin: string | null;
  declaredIn: string | null;
  signature: string | null;
  /** Other DMZ files of the publishing project that pass the same declaration on. */
  carriers: string[];
  /** Code of the publishing project that imports the declaration through those files. */
  inside: { file: string; line: number; bucket: string; via: string }[];
  consumers: (LinkConsumer & { holds: boolean })[];
}

/** Who is affected when `symbol` of the `.external.ts` file `file` changes. */
export function externalImpact(snapshot: InspectSnapshot, projectPath: string, file: string, symbol: string): ExternalImpact | { problem: string } {
  const project = snapshot.projects.find((p) => p.path === projectPath);
  if (!project) return { problem: `No project ${projectPath}.` };
  const contract = project.contracts.find((c) => c.file === file);
  if (!contract || contract.consumer !== EXTERNAL) return { problem: `${file} is not a .external file of ${project.name}.` };
  const entry = contract.symbols.find((s) => s.name === symbol);
  if (!entry) return { problem: `${file} does not publish ${symbol}. Pick a symbol from the list.` };
  const carriers: string[] = [];
  const inside: ExternalImpact['inside'] = [];
  for (const c of project.contracts) {
    if (c.file === file) continue;
    for (const s of c.symbols) {
      if (s.name !== symbol || s.declaredIn === null || s.declaredIn !== entry.declaredIn) continue;
      carriers.push(c.file);
      for (const imp of s.importers) inside.push({ file: imp.file, line: imp.line, bucket: imp.bucket, via: c.file });
    }
  }
  inside.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const consumers = consumersOf(snapshot, project, file, [symbol]).map((c) => {
    const link = snapshot.projects.find((p) => p.path === c.project)?.links.find((l) => l.path === c.link);
    return { ...c, holds: link?.symbols.some((s) => s.name === symbol) ?? false };
  });
  return { project: project.path, file, symbol, origin: entry.origin, declaredIn: entry.declaredIn, signature: entry.signature.text, carriers: sorted(carriers), inside, consumers };
}

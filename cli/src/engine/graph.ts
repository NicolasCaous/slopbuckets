// The import graph of one project, packed in typed arrays so the cache loads in a few milliseconds (spike: 4.9 ms for
// 10k files with v8.serialize). The edges of file i are edgeStart[i] .. edgeStart[i + 1]; the names of edge e are
// nameStart[e] .. nameStart[e + 1]. Specifiers and names are ids into `strings`.
import type { FileAnalysis, ImportRecord, ImportTarget } from '@slopbuckets/adapter-ts';

/** Edge targets below zero. */
export const T_OUTSIDE = -1; // npm package or Node built-in, installed or not
export const T_DYNAMIC = -2; // import() or require() with a non-literal argument
export const T_UNRESOLVED = -3; // does not resolve and is no file of the project (absolute, `#` import), or a file outside the listing
export const T_RELATIVE = -4; // a relative specifier that names no file
export const T_PATHS = -5; // matches a tsconfig paths pattern (the edge's `info`) and names no file
export const T_WORKSPACE = -6; // a workspace package that resolves to no file of the project
/** Targets that are import-unresolved: T_WORKSPACE <= t <= T_RELATIVE. */
export const isUnresolvedImport = (t: number) => t <= T_RELATIVE;
const UNRESOLVED_KINDS = { relative: T_RELATIVE, paths: T_PATHS, workspace: T_WORKSPACE, package: T_OUTSIDE, other: T_UNRESOLVED } as const;

/** Edge flags: the kind in the low 2 bits, then re-export and namespace (`*`). */
export const KIND_MASK = 3;
export const KIND_STATIC = 0;
export const KIND_DYNAMIC = 1;
export const KIND_REQUIRE = 2;
export const F_REEXPORT = 4;
export const F_NAMESPACE = 8;
const KINDS = { static: KIND_STATIC, dynamic: KIND_DYNAMIC, require: KIND_REQUIRE } as const;
export const KIND_NAMES = ['static', 'dynamic', 'require'] as const;

/** What the rules need from a public file. */
export interface PublicInfo {
  names: { name: string; line: number; typeOnly: boolean }[];
  /** First line with code other than named re-exports, 0 when none. */
  codeLine: number;
}

export interface Graph {
  /** Sorted. */
  files: string[];
  /** -1 for a file whose content came from a simulated edit. */
  mtime: Float64Array;
  size: Float64Array;
  /** The index blob of a tracked file that matched it when analyzed, '' otherwise. Such a file needs no stat. */
  blob: string[];
  edgeStart: Int32Array;
  target: Int32Array;
  line: Int32Array;
  flags: Uint8Array;
  spec: Int32Array;
  /** Per edge: the string id of the tsconfig paths pattern of a T_PATHS edge, -1 otherwise. */
  info: Int32Array;
  nameStart: Int32Array;
  names: Int32Array;
  nameType: Uint8Array;
  strings: string[];
  /** Public files only. */
  exports: Map<string, PublicInfo>;
  /** The names a file exports as types only (interface, type alias, export type), for each file that has one. */
  types: Map<string, string[]>;
}

export function emptyGraph(): Graph {
  return {
    files: [],
    mtime: new Float64Array(0),
    size: new Float64Array(0),
    blob: [],
    edgeStart: Int32Array.of(0),
    target: new Int32Array(0),
    line: new Int32Array(0),
    flags: new Uint8Array(0),
    spec: new Int32Array(0),
    info: new Int32Array(0),
    nameStart: Int32Array.of(0),
    names: new Int32Array(0),
    nameType: new Uint8Array(0),
    strings: [],
    exports: new Map(),
    types: new Map(),
  };
}

/** Index of `file` in the sorted list, or -1. */
export function indexOf(files: readonly string[], file: string): number {
  let lo = 0;
  let hi = files.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = files[mid]!;
    if (f === file) return mid;
    if (f < file) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Index of the first path in the sorted list that is not below `file`. */
export function lowerBound(files: readonly string[], file: string): number {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid]! < file) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class Builder {
  private readonly strings: string[];
  private ids: Map<string, number> | null = null;
  readonly edgeStart: number[] = [0];
  private readonly target: number[] = [];
  private readonly line: number[] = [];
  private readonly flags: number[] = [];
  private readonly spec: number[] = [];
  private readonly info: number[] = [];
  private readonly nameStart: number[] = [0];
  private readonly names: number[] = [];
  private readonly nameType: number[] = [];

  constructor(strings: readonly string[]) {
    this.strings = strings.slice();
  }

  private interned = 0;

  private intern(s: string): number {
    // An edit adds a few strings: a linear search beats building a map of every string of the project.
    if (this.ids === null && ++this.interned < 64) {
      const found = this.strings.indexOf(s);
      return found >= 0 ? found : this.strings.push(s) - 1;
    }
    this.ids ??= new Map(this.strings.map((x, i) => [x, i]));
    let id = this.ids.get(s);
    if (id === undefined) this.ids.set(s, (id = this.strings.push(s) - 1));
    return id;
  }

  /** `files` resolves a file target to its index. */
  addImport(imp: ImportRecord, files: readonly string[]): void {
    const t = imp.target;
    let target: number = T_DYNAMIC;
    let info = -1;
    if (imp.literal) {
      target = edgeTarget(t, files);
      if ('unresolved' in t && t.unresolved === 'paths' && t.pattern !== undefined) info = this.intern(t.pattern);
    }
    this.target.push(target);
    this.info.push(info);
    this.line.push(imp.line);
    this.flags.push(KINDS[imp.kind] | (imp.reexport ? F_REEXPORT : 0) | (imp.names === '*' ? F_NAMESPACE : 0));
    this.spec.push(this.intern(imp.specifier));
    if (imp.names !== '*') {
      for (const n of imp.names) {
        this.names.push(this.intern(n.name));
        this.nameType.push(n.typeOnly ? 1 : 0);
      }
    }
    this.nameStart.push(this.names.length);
  }

  /** Copies edge `e` of `g`; `resolved` replaces its target when the edge was resolved again. */
  copyEdge(g: Graph, e: number, target: number, resolved?: ImportTarget): void {
    this.target.push(target);
    this.info.push(resolved === undefined ? g.info[e]! : 'unresolved' in resolved && resolved.unresolved === 'paths' && resolved.pattern !== undefined ? this.intern(resolved.pattern) : -1);
    this.line.push(g.line[e]!);
    this.flags.push(g.flags[e]!);
    this.spec.push(g.spec[e]!);
    for (let k = g.nameStart[e]!; k < g.nameStart[e + 1]!; k++) {
      this.names.push(g.names[k]!);
      this.nameType.push(g.nameType[k]!);
    }
    this.nameStart.push(this.names.length);
  }

  endFile(): void {
    this.edgeStart.push(this.target.length);
  }

  build(files: string[], mtime: Float64Array, size: Float64Array, blob: string[], exports: Map<string, PublicInfo>, types: Map<string, string[]>): Graph {
    return {
      files,
      mtime,
      size,
      blob,
      edgeStart: Int32Array.from(this.edgeStart),
      target: Int32Array.from(this.target),
      line: Int32Array.from(this.line),
      flags: Uint8Array.from(this.flags),
      spec: Int32Array.from(this.spec),
      info: Int32Array.from(this.info),
      nameStart: Int32Array.from(this.nameStart),
      names: Int32Array.from(this.names),
      nameType: Uint8Array.from(this.nameType),
      strings: this.strings,
      exports,
      types,
    };
  }
}

export function toPublicInfo(analysis: FileAnalysis): PublicInfo | undefined {
  if (analysis.exports === undefined) return undefined;
  return { names: analysis.exports.names, codeLine: analysis.exports.codeLines[0] ?? 0 };
}

/** Keeps the exports of an analyzed file: all of them for a public file, and the type names for any file. */
function keepExports(changes: Changes, exports: Map<string, PublicInfo>, types: Map<string, string[]>, file: string, analysis: FileAnalysis): void {
  const info = toPublicInfo(analysis);
  if (info !== undefined && (changes.publicFiles?.has(file) ?? true)) exports.set(file, info);
  else exports.delete(file);
  const names = info?.names.filter((n) => n.typeOnly).map((n) => n.name) ?? [];
  if (names.length > 0) types.set(file, names);
  else types.delete(file);
}

export interface ResolveQuery {
  from: string;
  specifier: string;
  kind: (typeof KIND_NAMES)[number];
}

export interface Changes {
  /** The new sorted file list. */
  files: string[];
  /** mtime and size per file of `files`; NaN where the previous graph's value should stay. */
  mtime: Float64Array;
  size: Float64Array;
  /** Index blob per file of `files`, '' when unknown. Without it, copied files keep theirs and analyzed files get ''. */
  blob?: string[];
  /** New analyses. Every file of `files` that is not in the previous graph needs one. */
  analyses: Map<string, FileAnalysis>;
  /** Resolve every edge again (the tsconfig or package.json changed). */
  resolveAll: boolean;
  /** The public files, whose full exports the graph keeps. Without it, the graph keeps those of every analysis. */
  publicFiles?: ReadonlySet<string>;
}

/** The edge target of an adapter answer: a file index, or one of the T_ values. */
function edgeTarget(t: ImportTarget, files: readonly string[]): number {
  if ('file' in t) {
    const k = indexOf(files, t.file);
    return k >= 0 ? k : T_UNRESOLVED;
  }
  return 'unresolved' in t ? UNRESOLVED_KINDS[t.unresolved] : T_OUTSIDE;
}

const lastSegment = (s: string): string => s.slice(s.lastIndexOf('/') + 1).replace(/\.(d\.)?[cm]?[jt]sx?$/, '');

/**
 * The graph after `changes`. Edges of unchanged files are copied. Some must resolve again because files came or went:
 * every edge whose target is gone, and, when files were added, every edge whose specifier ends with the name of an
 * added file or of its folder for an index file, and every edge that did not resolve. `resolve` answers those in one
 * batch.
 */
export async function applyChanges(
  prev: Graph | null,
  changes: Changes,
  resolve: (queries: ResolveQuery[]) => Promise<ImportTarget[]>,
): Promise<Graph> {
  if (prev !== null && changes.files === prev.files && !changes.resolveAll) return replaceFiles(prev, changes);
  const old = prev ?? emptyGraph();
  const match = matchFiles(changes.files, old.files);
  if (prev === null) match.stems.clear();
  const { queries, queryEdges } = staleEdges(old, changes, match);
  const answers = new Map<number, ImportTarget>();
  if (queries.length > 0) {
    const targets = await resolve(queries);
    queryEdges.forEach((e, k) => {
      const t = targets[k];
      if (t !== undefined) answers.set(e, t);
    });
  }
  return rebuild(old, changes, match, answers);
}

/** How the new file list maps to the old one, and the names of the added files (their stems). */
interface FileMatch {
  newToOld: Int32Array;
  oldToNew: Int32Array;
  /** The base names of the added files, and the folder names of the added index files. */
  stems: Set<string>;
}

function matchFiles(files: readonly string[], oldFiles: readonly string[]): FileMatch {
  const newToOld = new Int32Array(files.length).fill(-1);
  const oldToNew = new Int32Array(oldFiles.length).fill(-1);
  const stems = new Set<string>();
  for (let i = 0, j = 0; i < files.length || j < oldFiles.length; ) {
    const a = files[i];
    const b = oldFiles[j];
    if (a !== undefined && a === b) {
      newToOld[i] = j;
      oldToNew[j] = i;
      i++;
      j++;
    } else if (a !== undefined && (b === undefined || a < b)) {
      const parts = a.split('/');
      const base = lastSegment(parts[parts.length - 1] ?? '');
      stems.add(base);
      if (base === 'index' && parts.length > 1) stems.add(parts[parts.length - 2] ?? '');
      i++;
    } else j++;
  }
  return { newToOld, oldToNew, stems };
}

/** The copied edges that must resolve again, as queries, with the old edge index of each. */
function staleEdges(old: Graph, changes: Changes, match: FileMatch): { queries: ResolveQuery[]; queryEdges: number[] } {
  const { files, analyses } = changes;
  const { newToOld, oldToNew, stems } = match;
  const queries: ResolveQuery[] = [];
  const queryEdges: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const oi = newToOld[i]!;
    if (oi < 0 || analyses.has(files[i]!)) continue;
    for (let e = old.edgeStart[oi]!; e < old.edgeStart[oi + 1]!; e++) {
      const t = old.target[e]!;
      if (t === T_DYNAMIC) continue;
      const spec = old.strings[old.spec[e]!]!;
      const again =
        changes.resolveAll ||
        (t >= 0 && oldToNew[t]! < 0) ||
        (stems.size > 0 && (t === T_UNRESOLVED || isUnresolvedImport(t) || stems.has(lastSegment(spec)) || /(^|\/)\.{1,2}$/.test(spec)));
      if (!again) continue;
      queries.push({ from: files[i]!, specifier: spec, kind: KIND_NAMES[old.flags[e]! & KIND_MASK]! });
      queryEdges.push(e);
    }
  }
  return { queries, queryEdges };
}

/** The new graph: the analyzed files from their analysis, the others copied with their targets moved or answered. */
function rebuild(old: Graph, changes: Changes, match: FileMatch, answers: Map<number, ImportTarget>): Graph {
  const { files, analyses } = changes;
  const { newToOld, oldToNew } = match;
  const N = files.length;
  const b = new Builder(old.strings);
  const mtime = new Float64Array(N);
  const size = new Float64Array(N);
  const blob: string[] = changes.blob ?? new Array<string>(N).fill('');
  const exports = new Map<string, PublicInfo>();
  const types = new Map<string, string[]>();
  for (let i = 0; i < N; i++) {
    const file = files[i]!;
    const oi = newToOld[i]!;
    if (changes.blob === undefined && oi >= 0 && !analyses.has(file)) blob[i] = old.blob[oi] ?? '';
    mtime[i] = Number.isNaN(changes.mtime[i]) && oi >= 0 ? old.mtime[oi]! : changes.mtime[i]!;
    size[i] = Number.isNaN(changes.size[i]) && oi >= 0 ? old.size[oi]! : changes.size[i]!;
    const analysis = analyses.get(file);
    if (analysis !== undefined) {
      for (const imp of analysis.imports) b.addImport(imp, files);
      keepExports(changes, exports, types, file, analysis);
    } else if (oi >= 0) {
      for (let e = old.edgeStart[oi]!; e < old.edgeStart[oi + 1]!; e++) {
        const t = old.target[e]!;
        const answer = answers.get(e);
        b.copyEdge(old, e, answer !== undefined ? edgeTarget(answer, files) : t >= 0 ? oldToNew[t]! : t, answer);
      }
      const info = old.exports.get(file);
      if (info !== undefined) exports.set(file, info);
      const names = old.types.get(file);
      if (names !== undefined) types.set(file, names);
    }
    b.endFile();
  }
  return b.build(files, mtime, size, blob, exports, types);
}

/**
 * applyChanges when the file list stays the same (an edit of existing files): no target moves, so the edges of the
 * other files are copied in blocks with TypedArray.set instead of one by one.
 */
function replaceFiles(old: Graph, changes: Changes): Graph {
  const N = old.files.length;
  const replaced = [...changes.analyses.keys()].map((f) => indexOf(old.files, f)).filter((i) => i >= 0);
  replaced.sort((a, b) => a - b);
  // The new edges of the replaced files, packed on their own.
  const b = new Builder(old.strings);
  const exports = new Map(old.exports);
  const types = new Map(old.types);
  for (const i of replaced) {
    const analysis = changes.analyses.get(old.files[i]!)!;
    for (const imp of analysis.imports) b.addImport(imp, old.files);
    b.endFile();
    keepExports(changes, exports, types, old.files[i]!, analysis);
  }
  const part = b.build([], new Float64Array(0), new Float64Array(0), [], new Map(), new Map());
  let E = old.target.length + part.target.length;
  let M = old.names.length + part.names.length;
  for (const i of replaced) {
    E -= old.edgeStart[i + 1]! - old.edgeStart[i]!;
    M -= old.nameStart[old.edgeStart[i + 1]!]! - old.nameStart[old.edgeStart[i]!]!;
  }
  const g: Graph = {
    files: old.files,
    mtime: Float64Array.from(old.mtime),
    size: Float64Array.from(old.size),
    blob: changes.blob ?? old.blob.slice(),
    edgeStart: new Int32Array(N + 1),
    target: new Int32Array(E),
    line: new Int32Array(E),
    flags: new Uint8Array(E),
    spec: new Int32Array(E),
    info: new Int32Array(E),
    nameStart: new Int32Array(E + 1),
    names: new Int32Array(M),
    nameType: new Uint8Array(M),
    strings: part.strings,
    exports,
    types,
  };
  let e = 0; // next edge in g
  let m = 0; // next name in g
  // Copies edges [from, to) of graph `src` (whole files) to the end of g.
  const copy = (src: Graph, from: number, to: number) => {
    const n0 = src.nameStart[from]!;
    const n1 = src.nameStart[to]!;
    g.target.set(src.target.subarray(from, to), e);
    g.line.set(src.line.subarray(from, to), e);
    g.flags.set(src.flags.subarray(from, to), e);
    g.spec.set(src.spec.subarray(from, to), e);
    g.info.set(src.info.subarray(from, to), e);
    g.names.set(src.names.subarray(n0, n1), m);
    g.nameType.set(src.nameType.subarray(n0, n1), m);
    for (let k = from; k < to; k++) g.nameStart[e + k - from] = m + src.nameStart[k]! - n0;
    e += to - from;
    m += n1 - n0;
  };
  let next = 0; // next file of `old` not yet copied
  replaced.forEach((i, k) => {
    for (let f = next; f < i; f++) g.edgeStart[f] = e + old.edgeStart[f]! - old.edgeStart[next]!;
    copy(old, old.edgeStart[next]!, old.edgeStart[i]!);
    g.edgeStart[i] = e;
    copy(part, part.edgeStart[k]!, part.edgeStart[k + 1]!);
    next = i + 1;
    if (changes.blob === undefined) g.blob[i] = '';
    const t = changes.mtime[i]!;
    if (!Number.isNaN(t)) {
      g.mtime[i] = t;
      g.size[i] = changes.size[i]!;
    }
  });
  for (let f = next; f <= N; f++) g.edgeStart[f] = e + old.edgeStart[f]! - old.edgeStart[next]!;
  copy(old, old.edgeStart[next]!, old.edgeStart[N]!);
  g.nameStart[E] = m;
  return g;
}

/** The file list with `add` inserted and `remove` taken out, sorted. */
export function editList(files: readonly string[], add: Iterable<string>, remove: Iterable<string>): string[] {
  // The common edit changes files already in the list: no set of every file (5 ms at 50k files).
  const gone = new Set(remove);
  const added = [...add];
  if ([...gone].every((f) => indexOf(files, f) < 0) && added.every((f) => indexOf(files, f) >= 0)) return files as string[];
  const set = new Set(files.filter((f) => !gone.has(f)));
  for (const f of added) set.add(f);
  return set.size === files.length && files.every((f) => set.has(f)) ? (files as string[]) : [...set].sort();
}

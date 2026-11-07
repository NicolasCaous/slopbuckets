// The cache of the rule engine in <project>/.buckets/cache/:
//
// - graph.bin (v8.serialize, string lists packed as in PackedCache): the sorted file list with mtime, size and index
//   blob, the import graph, the owners of each file under the config they were computed with, the violations of the
//   graph rules over that graph, the adapter's resolution state and the nested configs found.
// - state.json: the violation keys of the last full result and the mtime and size of the files they name and of the
//   tsconfig and package.json.
// - edits.json: the files checkEdit simulated since then. recheck answers from these two files without loading the
//   graph when none of the files they name moved on disk.
//
// Each file holds the cache version, the CLI version and the clone key (cloneKey), and is checked for shape when read.
// A file that fails either check counts as missing. Writes refuse a .buckets/ or cache/ folder that is a link.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import type { AdapterState, ResolutionInput } from '@slopbuckets/adapter-ts';
import type { Violation } from '../contract/index.js';
import { ensureBucketsDir, isRecord } from '../files/index.js';
import type { Config } from './config.js';
import { indexOf, TextList, type Graph } from './graph.js';
import type { Owners } from './owners.js';
import { violationFiles, type GraphRules } from './rules.js';

const CACHE_VERSION = 9;

/** What every file of the cache starts with. A file with another stamp is treated as missing. */
interface Stamp {
  v: number;
  cli: string;
  /** cloneKey of the repository that wrote it, so a cache that came in a commit is never trusted. */
  key: string;
}

export interface CacheFile extends Stamp {
  graph: Graph;
  /** The nested project folders whose files the graph leaves out, sorted. */
  projects: string[];
  owners: Owners | null;
  adapter: AdapterState;
  /** The adapter inputs the graph was resolved with. */
  inputs: ResolutionInput[];
  /** Folders inside the project that hold a buckets.config.json, declared projects left out. */
  configs: string[];
  /** Folders inside the project that hold a tsconfig.json, '' for the project folder. */
  tsconfigs: string[];
  /**
   * The graph rules of `graph` under `owners`, and the project label they ran with. graph.bin holds `result` as
   * v8.serialize gives it, and readRules reads it only when an edit can reuse it.
   */
  rules: { project: string; result: GraphRules | Uint8Array } | null;
}

/** The graph rules of a cache as new objects, or undefined when they do not read back. */
export function readRules(rules: NonNullable<CacheFile['rules']>): GraphRules | undefined {
  try {
    const r = (rules.result instanceof Uint8Array ? v8.deserialize(rules.result) : structuredClone(rules.result)) as Partial<GraphRules>;
    return Array.isArray(r.head) && Array.isArray(r.cycles) && Array.isArray(r.tail) ? (r as GraphRules) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * graph.bin as written. v8.deserialize makes one string per array entry, which took 30 ms for the 300k strings of
 * a 50k-file project, so a list is one string. `files`, which every call reads whole, is joined with NUL and split
 * after reading; the file list keeps its length, because [''] and [] join to the same text. The other lists are a
 * TextList: the text and the offset of each entry, which a read keeps as they are.
 */
type Packed = [length: number, text: string];
type PackedText = [starts: Int32Array, text: string];
type PackedCache = Omit<CacheFile, 'graph'> & { graph: Omit<Graph, 'files' | 'blob' | 'strings' | 'types'> & { files: Packed } & Record<'blob' | 'strings' | 'types', PackedText> };

const packList = (list: readonly string[]): Packed => [list.length, list.join('\0')];
function unpackList([length, text]: Packed): string[] {
  const list = length === 0 ? [] : text.split('\0');
  // A path holds no NUL, so a list that splits into another length is broken.
  if (list.length !== length) throw new Error('graph.bin has a list that does not split back');
  return list;
}
/**
 * Only the types of a list are checked. An offset out of order slices a wrong string, which no index of the engine
 * follows, and a pass over the 200k offsets of `strings` at 50k files would cost part of what the lazy read saves.
 */
function unpackText(p: PackedText): TextList {
  const [starts, text] = p;
  if (typeof text !== 'string' || !(starts instanceof Int32Array) || starts.length === 0) throw new Error('graph.bin has a list that does not read back');
  return TextList.packed(starts, text);
}
const pack = (c: CacheFile): PackedCache => ({
  ...c,
  graph: { ...c.graph, files: packList(c.graph.files), blob: c.graph.blob.pack(), strings: c.graph.strings.pack(), types: c.graph.types.pack() },
  rules: c.rules && { ...c.rules, result: c.rules.result instanceof Uint8Array ? c.rules.result : v8.serialize(c.rules.result) },
});
const unpack = (c: PackedCache): CacheFile => ({
  ...c,
  graph: { ...c.graph, files: unpackList(c.graph.files), blob: unpackText(c.graph.blob), strings: unpackText(c.graph.strings), types: unpackText(c.graph.types) },
});

export type Stats = Record<string, [number, number] | null>;

interface StateFile extends Stamp {
  configHash: string;
  /** Keys of the last full result, computed with project '.'. */
  keys: string[];
  /** mtime and size of the files those violations name, null for a file that did not exist. */
  stats: Stats;
  /** mtime and size of the adapter inputs (tsconfig, package.json) the result was resolved with, by path. */
  inputs: Stats;
}

/** edits.json: the files checkEdit simulated since the last full result, with their cached mtime and size. */
export interface EditsFile extends Stamp {
  stats: Stats;
}

/**
 * `outside` also takes absolute paths: the adapter names an input outside the project or under node_modules, such as
 * the package.json of typescript, by its absolute path. Without it every state.json failed this check, and recheck
 * never took its fast path (30 ms per pre-tool call at 10k files).
 */
const isStats = (v: unknown, outside = false): v is Stats =>
  isRecord(v) &&
  Object.entries(v).every(([f, s]) => (outside || !path.isAbsolute(f)) && !f.split('/').includes('..') && (s === null || (Array.isArray(s) && s.length === 2 && s.every((n) => typeof n === 'number'))));
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
function isInt32(v: unknown, length: number, min: number, max: number): v is Int32Array {
  if (!(v instanceof Int32Array) || v.length !== length) return false;
  for (let i = 0; i < length; i++) if (v[i]! < min || v[i]! >= max) return false;
  return true;
}
/** An offset column: length + 1 entries rising from 0 to `end`. */
function isStarts(v: unknown, length: number, end: number): v is Int32Array {
  if (!(v instanceof Int32Array) || v.length !== length + 1 || v[0] !== 0 || v[length] !== end) return false;
  for (let i = 1; i <= length; i++) if (v[i]! < v[i - 1]!) return false;
  return true;
}

/** True when the columns of the files and of the edges of a graph as read have the right type and length. */
function isFileColumns(g: Partial<Graph>): boolean {
  if (!isStrings(g.files) || !(g.blob instanceof TextList) || !(g.types instanceof TextList) || !(g.strings instanceof TextList) || !(g.exports instanceof Map)) return false;
  const n = g.files.length;
  return g.mtime instanceof Float64Array && g.mtime.length === n && g.size instanceof Float64Array && g.size.length === n && g.blob.length === n && g.types.length === n;
}

/** True when the edge and name columns of a graph whose file columns passed isFileColumns index within their arrays. */
function isEdgeColumns(g: Graph): boolean {
  const n = g.files.length;
  const e = g.target?.length ?? -1;
  const m = g.names?.length ?? -1;
  if (!isStarts(g.edgeStart, n, e) || !isInt32(g.target, e, -6, n) || !isInt32(g.line, e, 0, 2 ** 31 - 1) || !isInt32(g.spec, e, 0, g.strings.length)) return false;
  if (!isInt32(g.info, e, -1, g.strings.length)) return false;
  if (!(g.flags instanceof Uint8Array && g.flags.length === e) || !isStarts(g.nameStart, e, m) || !isInt32(g.names, m, 0, g.strings.length)) return false;
  return g.nameType instanceof Uint8Array && g.nameType.length === m;
}

const isOwners = (o: unknown, n: number): boolean => isRecord(o) && typeof o.hash === 'string' && isInt32(o.owner, n, -3, 2 ** 31 - 1) && o.hits instanceof Int32Array && o.overlaps instanceof Map;

/**
 * True when graph.bin as read holds what the engine indexes: every column of the right type and length, and every
 * index within its array. A cache of another shape is rebuilt instead of crashing a rule or a hook.
 */
function isCache(c: CacheFile): boolean {
  const g = c.graph as Partial<Graph> | undefined;
  if (!isRecord(g) || !isFileColumns(g) || !isEdgeColumns(g as Graph)) return false;
  for (const [f, info] of (g as Graph).exports) if (typeof f !== 'string' || !isRecord(info) || !Array.isArray(info.names) || typeof info.codeLine !== 'number') return false;
  if (c.owners !== null && !isOwners(c.owners, (g as Graph).files.length)) return false;
  if (c.rules !== null && !(isRecord(c.rules) && typeof c.rules.project === 'string' && c.rules.result instanceof Uint8Array)) return false;
  return isStrings(c.projects) && isStrings(c.configs) && isStrings(c.tsconfigs) && Array.isArray(c.inputs) && isRecord(c.adapter) && Array.isArray(c.adapter.inputs) && isRecord(c.adapter.resolved);
}

const cloneKeys = new Map<string, string>();
/**
 * A random key kept in the git folder of the repository that holds `dir`, created on first use. No commit carries
 * it, so a cache that arrived in a commit or a pull request has another key and is rebuilt: its graph could hide
 * violations, and its config hash would skip the config checks. Outside a repository the key is '', since no
 * commit can deliver the cache there.
 */
function cloneKey(dir: string): string {
  const known = cloneKeys.get(dir);
  if (known !== undefined) return known;
  let key = '';
  for (let d = path.resolve(dir); ; ) {
    const dotGit = path.join(d, '.git');
    let gitDir: string | null = null;
    try {
      // A worktree or a submodule has a .git file that names its git folder.
      gitDir = statSync(dotGit).isDirectory() ? dotGit : path.resolve(d, /^gitdir: *(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim() ?? '\0');
    } catch {
      // no .git here
    }
    if (gitDir !== null) {
      const file = path.join(gitDir, 'slopbuckets-cache-key');
      const read = () => /^[0-9a-f]{32}$/.exec(readText(file) ?? '')?.[0];
      key = read() ?? '';
      if (key === '') {
        const fresh = randomBytes(16).toString('hex');
        try {
          writeFileSync(file, fresh, { flag: 'wx' });
          key = fresh;
        } catch {
          // Another process made it first, or the git folder is read-only: then no key on disk can match, and the
          // cache is never trusted.
          key = read() ?? `none-${fresh}`;
        }
      }
      break;
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  cloneKeys.set(dir, key);
  return key;
}

export const cacheDir = (dir: string) => path.join(dir, '.buckets', 'cache');
export const sameStat = (a: [number, number] | null | undefined, b: [number, number] | null) => (a === null || b === null ? a === b : a !== undefined && a[0] === b[0] && a[1] === b[1]);
/** Two lists with the same entries in the same order. */
export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** True when every input of `before` is in `after` with the same hash: an input the adapter read for the first time does not count. */
export const sameInputs = (before: readonly ResolutionInput[], after: readonly ResolutionInput[]) => {
  const now = new Map(after.map((i) => [i.path, i.hash]));
  return before.every((i) => now.get(i.path) === i.hash);
};

/** mtime and size of a file, or of a folder when `folders` is set; null when there is none. */
export function statOf(file: string, folders = false): [number, number] | null {
  try {
    const s = statSync(file);
    return s.isFile() || (folders && s.isDirectory()) ? [s.mtimeMs, folders && s.isDirectory() ? -1 : s.size] : null;
  } catch {
    return null;
  }
}

export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Writes <dir>/.buckets/cache/<name> through a rename, unless .buckets or its cache folder is a link. */
function writeAtomic(dir: string, name: string, data: string | Uint8Array): void {
  const folder = ensureBucketsDir(dir, 'cache');
  if (folder === null) return;
  const file = path.join(folder, name);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, data, { flag: 'wx' });
    renameSync(tmp, file);
  } catch {
    // The cache is an optimization: a failed write (another process holds the file) only costs time later.
    rmSync(tmp, { force: true });
  }
}

/** mtime and size of each adapter input; a path outside the project is absolute. An input can be a folder (node_modules). */
export function inputStats(dir: string, inputs: readonly ResolutionInput[]): Stats {
  return Object.fromEntries(inputs.map((i) => [i.path, statOf(path.resolve(dir, i.path), true)]));
}

/** The cache files of every project one engine touches, with what it read during one call. */
export class CacheStore {
  // Caches read during one call of the engine, so the config check and the work share one read. Every entry point
  // clears it: a long-lived process (inspect) calls the engine again after files change.
  private readonly loaded = new Map<string, CacheFile | null>();
  // The last cache this engine read or wrote per project, with the mtime and size graph.bin had then. A long-lived
  // process (inspect) reuses it while no other process rewrote the file: 12 ms saved per call at 50k files.
  private readonly kept = new Map<string, { cache: CacheFile; stat: [number, number] | null }>();
  // Caches waiting for a write `later`: the newest per project.
  private readonly pendingWrites = new Map<string, CacheFile>();

  constructor(
    private readonly cli: string,
    /** violationKey with project '.', as state.json stores keys. */
    private readonly key: (v: Violation) => string,
  ) {}

  /** Starts a new call of the engine. */
  clear(): void {
    this.loaded.clear();
  }

  /** Drops the reusable copy of a project's cache: checkEdit changes its adapter state in place, and graph.bin never gets that state. */
  forget(dir: string): void {
    this.kept.delete(dir);
  }

  read(dir: string): CacheFile | null {
    if (this.loaded.has(dir)) return this.loaded.get(dir)!;
    // checkEdit drops `kept`: a cache still waiting for its write must not lose to the older file.
    if (this.pendingWrites.has(dir) && !this.kept.has(dir)) this.writeNow(dir, this.pendingWrites.get(dir)!);
    const file = path.join(cacheDir(dir), 'graph.bin');
    const now = statOf(file);
    const known = this.kept.get(dir);
    let c: CacheFile | null = null;
    // A copy of the adapter state, as a read from disk gives: the adapter keeps its resolver per state object and
    // checks the tsconfig and package.json hashes only when it makes one.
    if (known !== undefined && now !== null && sameStat(known.stat, now)) c = { ...known.cache, adapter: structuredClone(known.cache.adapter) };
    else {
      // Another process rewrote graph.bin: its file wins over a write still waiting here.
      this.pendingWrites.delete(dir);
      try {
        const raw = v8.deserialize(readFileSync(file)) as PackedCache;
        c = this.isStamped(raw, dir) ? unpack(raw) : null;
        if (c !== null && !isCache(c)) c = null;
      } catch {
        c = null;
      }
      if (c === null) this.kept.delete(dir);
      else this.kept.set(dir, { cache: c, stat: now });
    }
    this.loaded.set(dir, c);
    return c;
  }

  /**
   * Writes graph.bin. `later` writes it a moment after the call returns, the newest cache only: packing and writing
   * take 20 ms at 50k files, which a live snapshot should not wait for. Until then `kept` serves the new cache, under
   * the stat of the file on disk. A process that exits first leaves the older file, which only costs time later.
   */
  write(dir: string, c: CacheFile, later = false): void {
    this.loaded.set(dir, c);
    if (!later) return this.writeNow(dir, c);
    // unref: the timer never keeps a process alive. A project folder removed meanwhile gets no new .buckets/ folder,
    // since ensureBucketsDir never creates the project folder.
    if (!this.pendingWrites.has(dir)) setTimeout(() => this.pendingWrites.has(dir) && this.writeNow(dir, this.pendingWrites.get(dir)!), 250).unref();
    this.pendingWrites.set(dir, c);
    this.kept.set(dir, { cache: c, stat: statOf(path.join(cacheDir(dir), 'graph.bin')) });
  }

  private writeNow(dir: string, c: CacheFile): void {
    this.pendingWrites.delete(dir);
    writeAtomic(dir, 'graph.bin', v8.serialize(pack(c)));
    this.kept.set(dir, { cache: c, stat: statOf(path.join(cacheDir(dir), 'graph.bin')) });
  }

  stamp(dir: string): Stamp {
    return { v: CACHE_VERSION, cli: this.cli, key: cloneKey(dir) };
  }

  private isStamped(raw: unknown, dir: string): raw is Record<string, unknown> {
    return isRecord(raw) && raw.v === CACHE_VERSION && raw.cli === this.cli && raw.key === cloneKey(dir);
  }

  /** state.json, or null when it is missing, broken, of another shape or from another CLI or clone. */
  readState(dir: string): StateFile | null {
    const s = readJson(dir, 'state.json');
    return this.isStamped(s, dir) && typeof s.configHash === 'string' && isStrings(s.keys) && isStats(s.stats) && isStats(s.inputs, true) ? (s as unknown as StateFile) : null;
  }

  /** edits.json, empty when it is missing or not valid. */
  readEdits(dir: string): EditsFile {
    const e = readJson(dir, 'edits.json');
    return this.isStamped(e, dir) && isStats(e.stats) ? (e as unknown as EditsFile) : { ...this.stamp(dir), stats: {} };
  }

  writeEdits(dir: string, edits: EditsFile): void {
    writeAtomic(dir, 'edits.json', JSON.stringify(edits));
  }

  /** Records a full result in state.json. The files edits.json lists are part of it now, so edits.json goes, unless `edits` lists some still. */
  writeState(dir: string, config: Config, g: Graph, inputs: readonly ResolutionInput[], violations: Violation[], edits: EditsFile | null = null): void {
    const stats: Stats = {};
    for (const v of violations) {
      for (const f of violationFiles(v)) {
        if (f in stats) continue;
        const i = indexOf(g.files, f);
        stats[f] = i >= 0 ? [g.mtime[i]!, g.size[i]!] : statOf(path.join(dir, f));
      }
    }
    // Writing a file costs more than reading one under an antivirus, and most stop hooks change nothing.
    const text = JSON.stringify({ ...this.stamp(dir), configHash: config.hash, keys: violations.map(this.key), stats, inputs: inputStats(dir, inputs) } satisfies StateFile);
    if (readText(path.join(cacheDir(dir), 'state.json')) !== text) writeAtomic(dir, 'state.json', text);
    if (edits !== null && Object.keys(edits.stats).length > 0) this.writeEdits(dir, edits);
    else {
      // Through a linked folder the removal would reach a file outside the project.
      const folder = ensureBucketsDir(dir, 'cache');
      if (folder !== null) rmSync(path.join(folder, 'edits.json'), { force: true });
    }
  }
}

function readJson(dir: string, name: string): unknown {
  const text = readText(path.join(cacheDir(dir), name));
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

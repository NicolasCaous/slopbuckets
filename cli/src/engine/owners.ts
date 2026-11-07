// Which bucket owns each file. Globs compile once to regexes, indexed by their static folder prefix, so a file only
// tests the globs under one of its parent folders (22 ms for 50k files and 522 globs in the spike, against 82 s for
// path.matchesGlob). `ignore` applies first: an ignored file leaves the architecture before any bucket glob runs.
// Inside one list the globs apply in order, and a `!` glob takes back files that an earlier glob matched.
import type { OverlapOwner } from '../contract/index.js';
import { normalizeGlob, type Config } from './config.js';

export const UNOWNED = -1;
export const IGNORED = -2;
export const OVERLAP = -3;

/** More `**` than this in one glob is config-invalid. */
export const MAX_GLOBSTARS = 8;
/** More alternatives than this after expanding every {a,b} of one glob is config-invalid. */
export const MAX_ALTERNATIVES = 64;

/** A glob that cannot compile. `expected` completes "must be ..." of a config-invalid problem. */
export class GlobError extends Error {
  constructor(readonly expected: string) {
    super(`the glob must be ${expected}`);
  }
}

/** `*` is [^/]*, `**` is .*, and `globstar` is a whole `**` segment followed by `/`: (?:.*\/)?. */
type Token = { k: 'lit'; c: string } | { k: 'one' } | { k: 'class'; src: string; re: RegExp } | { k: 'star' } | { k: 'any' } | { k: 'globstar' };
const STARS = new Set(['star', 'any', 'globstar']);

/** The alternatives of a glob with every {a,b} expanded. Throws GlobError. */
function tokenize(glob: string): Token[][] {
  let alts: Token[][] = [[]];
  const push = (t: Token) => {
    for (const a of alts) {
      const last = a[a.length - 1];
      // A run such as `***` collapses to one token, so it counts as one wildcard below.
      if ((t.k === 'star' || t.k === 'any') && (last?.k === 'star' || last?.k === 'any')) a[a.length - 1] = { k: t.k === 'any' || last.k === 'any' ? 'any' : 'star' };
      else a.push(t);
    }
  };
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        if (atStart && glob[i + 2] === '/') {
          push({ k: 'globstar' });
          i += 2;
        } else {
          push({ k: 'any' });
          i += 1;
        }
      } else push({ k: 'star' });
    } else if (c === '?') push({ k: 'one' });
    else if (c === '{' && glob.indexOf('}', i) >= 0) {
      const end = glob.indexOf('}', i);
      const parts = glob
        .slice(i + 1, end)
        .split(',')
        .flatMap((p) => tokenize(p));
      if (alts.length * parts.length > MAX_ALTERNATIVES) throw new GlobError(`a glob with at most ${MAX_ALTERNATIVES} {a,b} alternatives`);
      alts = alts.flatMap((a) => parts.map((p) => [...a, ...p]));
      i = end;
    } else if (c === '[' && glob.indexOf(']', i) >= 0) {
      const end = glob.indexOf(']', i);
      const src = glob
        .slice(i, end + 1)
        .replace(/^\[!/, '[^')
        .replace(/\\/g, '\\\\');
      let re: RegExp;
      try {
        re = new RegExp(`^${src}$`);
      } catch {
        throw new GlobError(`a glob whose ${glob.slice(i, end + 1)} is a valid character class`);
      }
      push({ k: 'class', src, re });
      i = end;
    } else push({ k: 'lit', c });
  }
  return alts;
}

const escape = (c: string) => (/[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c);
function tokenRegex(tokens: Token[]): string {
  let re = '';
  for (const t of tokens) {
    if (t.k === 'lit') re += escape(t.c);
    else if (t.k === 'one') re += '[^/]';
    else if (t.k === 'class') re += t.src;
    else if (t.k === 'star') re += '[^/]*';
    else if (t.k === 'any') re += '.*';
    else re += '(?:.*/)?';
  }
  return re;
}

/**
 * Whether `s` matches `tokens`, by walking every position of the pattern at once: time grows with the length of the
 * path times the number of tokens, whatever the pattern. A regex with three or more wildcards can backtrack for
 * minutes on a path that almost matches.
 */
function walkMatch(tokens: Token[], s: string): boolean {
  const m = tokens.length;
  let at = new Uint8Array(m + 1); // at[i]: the pattern is at token i
  let inside = new Uint8Array(m + 1); // inside[i]: inside the globstar at token i, after its first character
  let nextAt = new Uint8Array(m + 1);
  let nextInside = new Uint8Array(m + 1);
  // A wildcard can match nothing, so being at it is also being at the token after it.
  const close = (a: Uint8Array) => {
    for (let i = 0; i < m; i++) if (a[i] && STARS.has(tokens[i]!.k)) a[i + 1] = 1;
  };
  at[0] = 1;
  close(at);
  for (let p = 0; p < s.length; p++) {
    const ch = s[p]!;
    nextAt.fill(0);
    nextInside.fill(0);
    let alive = false;
    for (let i = 0; i < m; i++) {
      const t = tokens[i]!;
      if (inside[i] || (at[i] && t.k === 'globstar')) {
        nextInside[i] = 1;
        if (ch === '/') nextAt[i + 1] = 1;
        alive = true;
      }
      if (!at[i]) continue;
      let to = -1;
      if (t.k === 'lit' ? ch === t.c : t.k === 'one' ? ch !== '/' : t.k === 'class' && t.re.test(ch)) to = i + 1;
      else if (t.k === 'star' ? ch !== '/' : t.k === 'any') to = i;
      if (to >= 0) {
        nextAt[to] = 1;
        alive = true;
      }
    }
    if (!alive) return false;
    close(nextAt);
    [at, nextAt] = [nextAt, at];
    [inside, nextInside] = [nextInside, inside];
  }
  return at[m] === 1;
}

/**
 * Compiles a glob to a test of a project-relative path. Supports **, *, ?, {a,b} and [...]. A glob with at most two
 * wildcards in each alternative becomes one regex, which backtracks at most quadratically on the length of a path;
 * any other glob is matched by walkMatch. Throws GlobError for a glob the config must not hold.
 */
export function compileGlob(glob: string): (file: string) => boolean {
  if ((glob.match(/\*\*/g)?.length ?? 0) > MAX_GLOBSTARS) throw new GlobError(`a glob with at most ${MAX_GLOBSTARS} **`);
  const alts = tokenize(glob);
  if (alts.every((a) => a.filter((t) => STARS.has(t.k)).length <= 2)) {
    const re = new RegExp(`^(?:${alts.map(tokenRegex).join('|')})$`);
    return (file) => re.test(file);
  }
  return (file) => alts.some((a) => walkMatch(a, file));
}

/** The folders of a glob before the first segment with a wildcard. */
function staticPrefix(glob: string): string {
  const segs = glob.split('/');
  const out: string[] = [];
  for (let i = 0; i < segs.length - 1; i++) {
    if (/[*?{[]/.test(segs[i]!)) break;
    out.push(segs[i]!);
  }
  return out.join('/');
}

/** Number of path segments without a wildcard: more means narrower. */
export function literalSegments(glob: string): number {
  return glob.replace(/^!/, '').split('/').filter((s) => s !== '' && !/[*?{[]/.test(s)).length;
}

/** match(file) returns the ids of every glob that matches, sorted. */
export function makeMatcher(globs: readonly string[]): (file: string) => number[] {
  const byPrefix = new Map<string, { id: number; test: (file: string) => boolean }[]>();
  globs.forEach((glob, id) => {
    const g = normalizeGlob(glob).replace(/^!/, '');
    const p = staticPrefix(g);
    let list = byPrefix.get(p);
    if (list === undefined) byPrefix.set(p, (list = []));
    // Compiled on first use: a hook classifies a few files, and compiling the globs of 500 buckets takes 3 ms.
    let test: ((file: string) => boolean) | null = null;
    list.push({ id, test: (file) => (test ??= compileGlob(g))(file) });
  });
  return (file) => {
    const hits: number[] = [];
    let i = -1;
    for (;;) {
      const list = byPrefix.get(i < 0 ? '' : file.slice(0, i));
      if (list !== undefined) for (const g of list) if (g.test(file)) hits.push(g.id);
      const j = file.indexOf('/', i + 1);
      if (j < 0) break;
      i = j;
    }
    return hits.length > 1 ? hits.sort((a, b) => a - b) : hits;
  };
}

/** Every glob of a config in one list: each bucket's files in order, then ignore. */
export interface GlobTable {
  globs: string[];
  /** Bucket index of each glob, -1 for ignore. */
  bucket: Int32Array;
  negative: Uint8Array;
}

export function globTable(config: Config): GlobTable {
  const globs: string[] = [];
  const bucket: number[] = [];
  config.buckets.forEach((b, i) => {
    for (const g of b.files) {
      globs.push(g);
      bucket.push(i);
    }
  });
  for (const g of config.ignore) {
    globs.push(g);
    bucket.push(-1);
  }
  return { globs, bucket: Int32Array.from(bucket), negative: Uint8Array.from(globs, (g) => (g.startsWith('!') ? 1 : 0)) };
}

export interface Owners {
  /** The config hash these owners belong to. */
  hash: string;
  /** Per file: a bucket index, UNOWNED, IGNORED or OVERLAP. */
  owner: Int32Array;
  /** Per glob of the GlobTable: files it matches, or excludes for a `!` glob. */
  hits: Int32Array;
  /** The owners of each file in two or more buckets, in message order. */
  overlaps: Map<string, OverlapOwner[]>;
  /** The config-cycle cycles of this config, filled by the rules on first use. */
  cycles?: string[][];
  /** The reason-generic advice of this config without its project, filled by computeAdvice on first use. */
  reasons?: { at: (string | number)[]; text: string; why: 'short' | 'generic' }[];
}

interface Classifier {
  table: GlobTable;
  match: (file: string) => number[];
  config: Config;
}

/** The globs go into a matcher on the first file classified: an edit that keeps the file list classifies none. */
function classifier(config: Config): Classifier {
  const table = globTable(config);
  let match: ((file: string) => number[]) | null = null;
  return { table, match: (file) => (match ??= makeMatcher(table.globs))(file), config };
}

/** Owner of one file. Adds `sign` to the hit count of each glob that took part. */
function classify(c: Classifier, file: string, hits: Int32Array, sign: number, overlaps: Map<string, OverlapOwner[]>): number {
  const ids = c.match(file);
  if (ids.length === 0) return UNOWNED;
  const { bucket, negative, globs } = c.table;
  // ignore globs come last in the table
  let ignored = false;
  for (const id of ids) {
    if (bucket[id] !== -1) continue;
    if (negative[id]) {
      if (ignored) hits[id] = (hits[id] ?? 0) + sign;
      ignored = false;
    } else {
      hits[id] = (hits[id] ?? 0) + sign;
      ignored = true;
    }
  }
  if (ignored) return IGNORED;
  const members: { bucket: number; glob: number }[] = [];
  let current = -1;
  let via = -1;
  const close = () => {
    if (current >= 0 && via >= 0) members.push({ bucket: current, glob: via });
  };
  for (const id of ids) {
    const b = bucket[id]!;
    if (b === -1) continue;
    if (b !== current) {
      close();
      current = b;
      via = -1;
    }
    if (negative[id]) {
      if (via >= 0) {
        hits[id] = (hits[id] ?? 0) + sign;
        via = -1;
      }
    } else {
      hits[id] = (hits[id] ?? 0) + sign;
      via = id;
    }
  }
  close();
  if (members.length === 0) return UNOWNED;
  if (members.length === 1) return members[0]!.bucket;
  if (sign > 0) {
    const owners = members.map((m) => ({ bucket: c.config.buckets[m.bucket]!.name, glob: globs[m.glob]! }));
    owners.sort((a, b) => literalSegments(a.glob) - literalSegments(b.glob) || (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
    overlaps.set(file, owners);
  } else overlaps.delete(file);
  return OVERLAP;
}

/**
 * Owners of `files` (sorted) under `config`. With the owners of an earlier file list under the same config, only the
 * files added or removed since are matched again.
 */
export function computeOwners(files: readonly string[], config: Config, prev?: { files: readonly string[]; owners: Owners }): Owners {
  const c = classifier(config);
  if (prev === undefined || prev.owners.hash !== config.hash || prev.owners.hits.length !== c.table.globs.length) {
    const hits = new Int32Array(c.table.globs.length);
    const overlaps = new Map<string, OverlapOwner[]>();
    const owner = new Int32Array(files.length);
    for (let i = 0; i < files.length; i++) owner[i] = classify(c, files[i]!, hits, 1, overlaps);
    return { hash: config.hash, owner, hits, overlaps };
  }
  // An edit of existing files keeps the list array (applyChanges), so nothing moves.
  if (files === prev.files) return prev.owners;
  const old = prev.files;
  const hits = Int32Array.from(prev.owners.hits);
  const overlaps = new Map(prev.owners.overlaps);
  const owner = new Int32Array(files.length);
  let i = 0;
  let j = 0;
  while (i < files.length || j < old.length) {
    const a = files[i];
    const b = old[j];
    if (a !== undefined && a === b) owner[i++] = prev.owners.owner[j++]!;
    else if (b === undefined || (a !== undefined && a < b)) owner[i] = classify(c, files[i++]!, hits, 1, overlaps);
    else classify(c, old[j++]!, hits, -1, overlaps);
  }
  return { hash: config.hash, owner, hits, overlaps, ...(prev.owners.cycles ? { cycles: prev.owners.cycles } : {}), ...(prev.owners.reasons ? { reasons: prev.owners.reasons } : {}) };
}

/** The owner of any path under `config`, such as the file an unresolved import would name, without counting hits. */
export function pathOwner(config: Config): (file: string) => number {
  const c = classifier(config);
  const hits = new Int32Array(c.table.globs.length);
  const overlaps = new Map<string, OverlapOwner[]>();
  return (file) => classify(c, file, hits, 0, overlaps);
}

/** Whether ignore matches a path under `config`, without compiling the bucket globs. */
export function ignoredPath(config: Config): (file: string) => boolean {
  const match = makeMatcher(config.ignore);
  return (file) => {
    let ignored = false;
    for (const id of match(file)) ignored = !config.ignore[id]!.startsWith('!');
    return ignored;
  };
}

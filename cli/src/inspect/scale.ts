// Layout decisions of `buckets inspect` for projects of any size. A project with a few dozen buckets shows every
// bucket on the map and every DMZ folder as a full table, as before. A larger one shows one level of the map at a
// time (or a treemap of every bucket on request), sparse matrix tables, and a grouped list instead of a table that
// would be too wide to read. These functions only decide; the pages render.
import { worstSituation, type BucketSnapshot, type ContractSnapshot, type ProjectSnapshot, type Situation } from './snapshot.js';

/** Above this many buckets the map shows one level at a time. */
export const MAP_LEVEL_THRESHOLD = 40;
/** A matrix table with at most this many providers and consumers stays complete, empty rows included. */
export const MATRIX_FULL_MAX = 8;
/** A sparse matrix table with more providers or consumers than this becomes a list grouped by provider. */
export const MATRIX_LIST_THRESHOLD = 15;

export type MapMode = 'full' | 'level' | 'treemap';
export type Focus = 'problems' | 'pending';

/** What a bucket holds with everything below it. */
export interface SubtreeStats {
  /** Buckets below it. */
  inside: number;
  files: number;
  violations: number;
  orphans: number;
  lockChanges: number;
  /** The worst situation of the bucket and every bucket below it. */
  situation: Situation;
}

const statsCache = new WeakMap<ProjectSnapshot, Map<string, SubtreeStats>>();

/** Own counts of each bucket, with orphans counted apart. */
function ownOrphans(project: ProjectSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of project.violations) if (v.kind === 'orphan' && v.bucket !== null) out.set(v.bucket, (out.get(v.bucket) ?? 0) + 1);
  return out;
}

/** Subtree counts of every bucket of a project, computed once per snapshot. */
export function subtreeStats(project: ProjectSnapshot): Map<string, SubtreeStats> {
  const cached = statsCache.get(project);
  if (cached) return cached;
  const byPath = new Map(project.buckets.map((b) => [b.path, b]));
  const orphans = ownOrphans(project);
  const out = new Map<string, SubtreeStats>();
  const visit = (b: BucketSnapshot): SubtreeStats => {
    const own: SubtreeStats = { inside: 0, files: b.files, violations: b.violations, orphans: orphans.get(b.path) ?? 0, lockChanges: b.lockChanges, situation: b.situation };
    for (const c of b.children) {
      const child = byPath.get(c);
      if (!child) continue;
      const k = visit(child);
      own.inside += 1 + k.inside;
      own.files += k.files;
      own.violations += k.violations;
      own.orphans += k.orphans;
      own.lockChanges += k.lockChanges;
      own.situation = worstSituation(own.situation, k.situation);
    }
    out.set(b.path, own);
    return own;
  };
  const root = project.buckets.find((b) => b.parent === null);
  if (root) visit(root);
  statsCache.set(project, out);
  return out;
}

/** Orphan contracts of each bucket itself (not of its subtree). */
export function orphanCounts(project: ProjectSnapshot): Map<string, number> {
  return ownOrphans(project);
}

/** How the map of a project is laid out: all of a small project, one level or a treemap of a large one. */
export function mapMode(project: ProjectSnapshot, layout: 'all' | null): MapMode {
  if (project.buckets.length <= MAP_LEVEL_THRESHOLD) return 'full';
  return layout === 'all' ? 'treemap' : 'level';
}

/** True when the project is large enough for the one-level map, the tree filters and the layout switch. */
export function isLarge(project: ProjectSnapshot): boolean {
  return project.buckets.length > MAP_LEVEL_THRESHOLD;
}

/**
 * The bucket whose children the one-level map shows: the selected bucket when it has children, otherwise its parent,
 * and the root bucket when nothing is selected. Selecting a box drills into it; the breadcrumb goes back up.
 */
export function mapFocus(project: ProjectSnapshot, selected: string | null): string {
  const root = project.buckets.find((b) => b.parent === null)?.path ?? project.config?.root ?? 'root';
  const bucket = selected !== null ? project.buckets.find((b) => b.path === selected) : undefined;
  if (!bucket) return root;
  if (bucket.children.length > 0) return bucket.path;
  return bucket.parent ?? bucket.path;
}

/**
 * The box that stands for `bucket` on the one-level map of `focus`: the focus itself, the child of the focus that
 * holds it, or null when the bucket lies outside the focus.
 */
export function visibleBox(focus: string, bucket: string): string | null {
  if (bucket === focus) return focus;
  if (!bucket.startsWith(`${focus}/`)) return null;
  const next = bucket.slice(focus.length + 1).split('/')[0]!;
  return `${focus}/${next}`;
}

/** The deepest bucket that holds every bucket in `paths`. */
export function commonBucket(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let parts = paths[0]!.split('/');
  for (const p of paths.slice(1)) {
    const other = p.split('/');
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/** True when a bucket matches the tree filters: a text in its path, and problems or a pending approval in it. */
export function bucketMatches(bucket: BucketSnapshot, query: string, focus: Focus | null): boolean {
  const q = query.trim().toLowerCase();
  if (q !== '' && !bucket.path.toLowerCase().includes(q)) return false;
  if (focus === 'problems' && bucket.violations === 0) return false;
  if (focus === 'pending' && bucket.lockChanges === 0) return false;
  return true;
}

/** True when a contract matches the matrix filters: a text in its path or symbols, and problems or a pending approval. */
export function contractMatches(contract: ContractSnapshot, query: string, focus: Focus | null): boolean {
  const q = query.trim().toLowerCase();
  if (q !== '' && !contract.file.toLowerCase().includes(q) && !contract.symbols.some((s) => s.name.toLowerCase().includes(q))) return false;
  if (focus === 'problems' && contract.situation !== 'violation') return false;
  if (focus === 'pending' && contract.lock === null) return false;
  return true;
}

export interface MatrixLayout {
  owner: string;
  /** Rows and columns in table order. */
  providers: string[];
  consumers: string[];
  /** The contracts the filters keep, by `provider\0consumer`. */
  contracts: Map<string, ContractSnapshot>;
  /** Contract files of this folder deleted since the approval, shown as `del` cells. */
  removed: Set<string>;
  /** Every contract of the folder, before the filters. */
  total: number;
  /** True when empty rows and columns were left out. */
  sparse: boolean;
  /** `list` when the table would be too wide to read, unless `table` asked for it. */
  mode: 'table' | 'list';
  /** True when the table could be a list (so the page offers the switch back). */
  wide: boolean;
}

/**
 * The matrix of one DMZ folder: every provider and consumer while the folder is small and nothing is filtered,
 * otherwise only the rows and columns with a contract (sparse), and a list grouped by provider when that is still
 * wider than MATRIX_LIST_THRESHOLD. Null when the filters leave nothing in the folder.
 */
export function matrixLayout(project: ProjectSnapshot, owner: BucketSnapshot, filter: { q: string; focus: Focus | null }, asTable: boolean): MatrixLayout | null {
  const children = owner.children.map((c) => c.slice(c.lastIndexOf('/') + 1));
  const isRoot = owner.parent === null;
  const allProviders = [...children, '.self', ...(isRoot ? [] : ['.parent'])];
  const allConsumers = [...children, '.self', ...(isRoot ? [] : ['.parent']), '.external'];
  const own = project.contracts.filter((c) => c.owner === owner.path);
  const filtered = filter.q.trim() !== '' || filter.focus !== null;
  const shown = own.filter((c) => contractMatches(c, filter.q, filter.focus));
  const removedFiles = filter.focus === 'problems' || filter.q.trim() !== '' ? [] : project.lockChanges.filter((c) => c.kind === 'dmz-removed' && c.path.startsWith(`${owner.path}/dmz/`));
  const removed = new Set(removedFiles.map((c) => c.path));
  if (filtered && shown.length === 0 && removed.size === 0) return null;
  const contracts = new Map(shown.map((c) => [`${c.provider}\0${c.consumer}`, c]));
  const full = !filtered && Math.max(allProviders.length, allConsumers.length) <= MATRIX_FULL_MAX;
  let providers = allProviders;
  let consumers = allConsumers;
  if (!full) {
    const usedP = new Set<string>();
    const usedC = new Set<string>();
    for (const c of shown) {
      usedP.add(c.provider);
      usedC.add(c.consumer);
    }
    for (const file of removed) {
      const parts = file.slice(owner.path.length + '/dmz/'.length).split('/');
      if (parts.length === 2) {
        usedP.add(parts[0]!);
        usedC.add(parts[1]!.replace(/\.[^.]+$/, ''));
      }
    }
    providers = allProviders.filter((p) => usedP.has(p));
    consumers = allConsumers.filter((c) => usedC.has(c));
  }
  const wide = Math.max(providers.length, consumers.length) > MATRIX_LIST_THRESHOLD;
  return { owner: owner.path, providers, consumers, contracts, removed, total: own.length, sparse: !full, mode: wide && !asTable ? 'list' : 'table', wide };
}

/** Splits a long list: the first `cap` items, and the rest unless `expanded`. */
export function capList<T>(items: readonly T[], cap: number, expanded: boolean): { shown: T[]; rest: T[] } {
  if (expanded || items.length <= cap + Math.ceil(cap / 4)) return { shown: [...items], rest: [] };
  return { shown: items.slice(0, cap), rest: items.slice(cap) };
}

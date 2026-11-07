// Pure data work of the inspect page: indexes, sorts, filters, the matrix order, the file tree, search and the diff
// between two snapshots. No DOM here, so vitest covers it in Node.
import {
  renderSummary,
  RULE_IDS,
  violationBuckets,
  violationKey,
  type FileOwner,
  type SnapshotBucket,
  type SnapshotEdge,
  type SnapshotExport,
  type SnapshotImport,
  type SnapshotProject,
  type SnapshotV2,
  type Violation,
} from '../../contract/browser.js';
import type { Selection } from '../graph/types.js';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const edgeId = (from: string, to: string) => `${from}->${to}`;

/** Above this many buckets the graph opens in focus mode and the matrix draws on a canvas. */
export const FOCUS_ABOVE = 60;
export const CANVAS_ABOVE = 200;

export interface ProjectIndex {
  project: SnapshotProject;
  buckets: Map<string, SnapshotBucket>;
  edges: Map<string, SnapshotEdge>;
  outEdges: Map<string, SnapshotEdge[]>;
  /** Violations by bucket, from violationBuckets. */
  pending: Map<string, Violation[]>;
  /** Bucket names in the graph's layer order: buckets that depend on others first, the ones nothing below them last. */
  order: string[];
  /** Imports by importing file and by imported file, for the file panel. */
  importsFrom: Map<string, { edge: SnapshotEdge; imp: SnapshotImport }[]>;
  importsTo: Map<string, { edge: SnapshotEdge; imp: SnapshotImport }[]>;
}

export function indexProject(project: SnapshotProject): ProjectIndex {
  const buckets = new Map(project.buckets.map((b) => [b.name, b]));
  const edges = new Map<string, SnapshotEdge>();
  const outEdges = new Map<string, SnapshotEdge[]>();
  const importsFrom: ProjectIndex['importsFrom'] = new Map();
  const importsTo: ProjectIndex['importsTo'] = new Map();
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const edge of project.edges) {
    edges.set(edgeId(edge.from, edge.to), edge);
    push(outEdges, edge.from, edge);
    for (const imp of edge.imports) {
      push(importsFrom, imp.file, { edge, imp });
      push(importsTo, imp.target, { edge, imp });
    }
  }
  const pending = new Map<string, Violation[]>();
  for (const v of project.violations) for (const b of new Set(violationBuckets(v))) push(pending, b, v);
  return { project, buckets, edges, outEdges, pending, order: layerOrder(project.buckets), importsFrom, importsTo };
}

/**
 * Longest-path layering over declared dependencies: a bucket sits above everything it depends on, so every edge goes
 * down. Ties sort by name. A cycle (config-cycle) is cut where the walk meets it again.
 */
export function layerOrder(buckets: readonly SnapshotBucket[]): string[] {
  const deps = new Map(buckets.map((b) => [b.name, b.dependsOn.map((d) => d.bucket)]));
  const height = new Map<string, number>();
  const visiting = new Set<string>();
  const h = (name: string): number => {
    const known = height.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0;
    visiting.add(name);
    let best = 0;
    for (const d of deps.get(name)!) if (deps.has(d)) best = Math.max(best, h(d) + 1);
    visiting.delete(name);
    height.set(name, best);
    return best;
  };
  return [...deps.keys()].sort((a, b) => h(b) - h(a) || cmp(a, b));
}

export interface MatrixCell {
  row: number;
  col: number;
  edge: SnapshotEdge;
}

/** One cell per edge, row = importing bucket, column = imported bucket, both in layer order. */
export function matrixCells(index: ProjectIndex): MatrixCell[] {
  const pos = new Map(index.order.map((name, i) => [name, i]));
  const cells: MatrixCell[] = [];
  for (const edge of index.project.edges) {
    const row = pos.get(edge.from);
    const col = pos.get(edge.to);
    if (row !== undefined && col !== undefined) cells.push({ row, col, edge });
  }
  return cells;
}

/** What a matrix cell shows: the import count, or a mark for a declared dependency without imports. */
export function cellText(edge: SnapshotEdge): string {
  return edge.state === 'unused' ? '0' : String(edge.imports.length);
}

export function cellTitle(edge: SnapshotEdge): string {
  const n = edge.imports.length;
  const what = { used: `${n} import${n === 1 ? '' : 's'}`, unused: 'declared, never imported', undeclared: `undeclared, ${n} import${n === 1 ? '' : 's'}` }[edge.state];
  return `${edge.from} -> ${edge.to}: ${what}`;
}

export const SORT_KEYS = ['name', 'files', 'dependencies', 'dependents', 'pending'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** The bucket list: filtered by name or purpose, sorted by name ascending or by a count descending. */
export function bucketRows(index: ProjectIndex, sort: SortKey, filter: string): SnapshotBucket[] {
  const f = filter.trim().toLowerCase();
  const rows = f === '' ? [...index.project.buckets] : index.project.buckets.filter((b) => b.name.includes(f) || b.purpose.toLowerCase().includes(f));
  const value = (b: SnapshotBucket): number => {
    switch (sort) {
      case 'files':
        return b.fileCount;
      case 'dependencies':
        return index.outEdges.get(b.name)?.length ?? 0;
      case 'dependents':
        return b.dependents.length;
      case 'pending':
        return index.pending.get(b.name)?.length ?? 0;
      case 'name':
        return 0;
    }
  };
  return rows.sort((a, b) => value(b) - value(a) || cmp(a.name, b.name));
}

/**
 * The bucket the graph focuses on when it opens in focus mode: the one with the most pending items, or, when nothing
 * is pending, a top-layer bucket (no dependents, when one exists) with the most dependencies. A bucket with many dependents would make
 * a small focus large. Ties go to the first name.
 */
export function focusBucket(index: ProjectIndex): string | null {
  const score = (b: SnapshotBucket): number =>
    index.project.violations.length > 0 ? (index.pending.get(b.name)?.length ?? 0) : b.dependsOn.length + (b.dependents.length === 0 ? 1e6 : 0);
  let best: SnapshotBucket | null = null;
  for (const b of index.project.buckets) if (best === null || score(b) > score(best) || (score(b) === score(best) && b.name < best.name)) best = b;
  return best?.name ?? null;
}

/**
 * The selection the graph draws. The graph has no file nodes, so a selected file shows as its bucket (the first one
 * when two buckets claim it). A file without a bucket in a project above FOCUS_ABOVE focuses where the graph opens,
 * instead of drawing every bucket at once.
 */
export function graphSelection(index: ProjectIndex, selection: Selection, owner: FileOwner | undefined): Selection {
  if (selection.kind !== 'file') return selection;
  const name = owner?.state === 'bucket' ? owner.bucket : owner?.state === 'overlap' ? owner.buckets[0] : undefined;
  const bucket = name ?? (index.project.buckets.length > FOCUS_ABOVE ? focusBucket(index) : null);
  return bucket ? { kind: 'bucket', name: bucket } : selection;
}

export function ownerLabel(owner: FileOwner): string {
  switch (owner.state) {
    case 'bucket':
      return owner.bucket;
    case 'ignored':
      return 'ignored';
    case 'unowned':
      return 'no bucket';
    case 'overlap':
      return owner.buckets.length === 2 ? 'two buckets' : `${owner.buckets.length} buckets`;
  }
}

export interface FileEntry {
  name: string;
  path: string;
  owner: FileOwner;
}

export interface DirNode {
  name: string;
  path: string;
  dirs: DirNode[];
  files: FileEntry[];
}

/** Builds the folder tree from the snapshot's grouped files. Folders and files sort by name. */
export function buildFileTree(project: SnapshotProject): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] };
  const dirs = new Map<string, DirNode>([['', root]]);
  const ensure = (path: string): DirNode => {
    let node = dirs.get(path);
    if (node) return node;
    const cut = path.lastIndexOf('/');
    node = { name: path.slice(cut + 1), path, dirs: [], files: [] };
    ensure(cut === -1 ? '' : path.slice(0, cut)).dirs.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const group of project.files) {
    const node = ensure(group.dir);
    for (const name of group.names) node.files.push({ name, path: group.dir === '' ? name : `${group.dir}/${name}`, owner: group.owner });
  }
  for (const node of dirs.values()) {
    node.dirs.sort((a, b) => cmp(a.name, b.name));
    node.files.sort((a, b) => cmp(a.name, b.name));
  }
  return root;
}

export const OWNER_FILTERS = ['all', 'bucket', 'ignored', 'unowned', 'overlap'] as const;
export type OwnerFilter = (typeof OWNER_FILTERS)[number];

export interface TreeRow {
  depth: number;
  name: string;
  path: string;
  /** Null for a folder. */
  owner: FileOwner | null;
  /** Matching files inside a folder, 1 for a file. */
  count: number;
  collapsed: boolean;
}

/** The visible rows of the tree: folders hold only files that pass the filters, and collapsed folders hide their content. */
export function flattenTree(root: DirNode, collapsed: ReadonlySet<string>, filter: OwnerFilter, text: string): TreeRow[] {
  const t = text.trim().toLowerCase();
  const keep = (f: FileEntry) => (filter === 'all' || f.owner.state === filter) && (t === '' || f.path.toLowerCase().includes(t));
  const walk = (node: DirNode, depth: number, out: TreeRow[]): number => {
    let count = 0;
    for (const dir of node.dirs) {
      const shut = collapsed.has(dir.path);
      const row: TreeRow = { depth, name: dir.name, path: dir.path, owner: null, count: 0, collapsed: shut };
      if (!shut) out.push(row);
      const n = walk(dir, depth + 1, shut ? [] : out);
      // An open folder without matches added nothing after its own row, so its row is still the last one.
      if (n === 0) {
        if (!shut) out.pop();
        continue;
      }
      if (shut) out.push(row);
      row.count = n;
      count += n;
    }
    for (const f of node.files) {
      if (!keep(f)) continue;
      out.push({ depth, name: f.name, path: f.path, owner: f.owner, count: 1, collapsed: false });
      count++;
    }
    return count;
  };
  const rows: TreeRow[] = [];
  walk(root, 0, rows);
  return rows;
}

export interface SearchItem {
  kind: 'bucket' | 'export' | 'file';
  label: string;
  detail: string;
  selection: Selection;
  /** Lowercase label, the text that search matches. */
  key: string;
}

export function searchItems(project: SnapshotProject): SearchItem[] {
  const items: SearchItem[] = [];
  for (const b of project.buckets) {
    items.push({ kind: 'bucket', label: b.name, detail: b.purpose, selection: { kind: 'bucket', name: b.name }, key: b.name });
    // A name that two public files of the bucket export is one export selection, so it is listed once.
    const names = new Set<string>();
    for (const pub of b.public) {
      for (const e of pub.exports) {
        if (names.has(e.name)) continue;
        names.add(e.name);
        items.push({ kind: 'export', label: e.name, detail: `export of ${b.name}`, selection: { kind: 'export', bucket: b.name, name: e.name }, key: e.name.toLowerCase() });
      }
    }
  }
  for (const group of project.files) {
    for (const name of group.names) {
      const path = group.dir === '' ? name : `${group.dir}/${name}`;
      items.push({ kind: 'file', label: path, detail: ownerLabel(group.owner), selection: { kind: 'file', path }, key: path.toLowerCase() });
    }
  }
  return items;
}

const KIND_RANK = { bucket: 0, export: 1, file: 2 };

/** 0 exact, 1 prefix (or file name prefix), 2 prefix of a path or name segment, 3 anywhere, -1 no match. */
export function matchScore(item: SearchItem, q: string): number {
  const at = item.key.indexOf(q);
  if (at === -1) return -1;
  if (item.key === q) return 0;
  if (at === 0 || (item.kind === 'file' && item.key.startsWith(q, item.key.lastIndexOf('/') + 1))) return 1;
  for (let i = at; i !== -1; i = item.key.indexOf(q, i + 1)) if ('/-_.'.includes(item.key[i - 1]!)) return 2;
  return 3;
}

/**
 * Ranks by match score, then buckets before exports before files, then shorter labels, then name. An exact match
 * with the same case comes first, so `paymentsGateway` finds that export before `PaymentsGateway`.
 */
export function search(items: readonly SearchItem[], query: string, limit = 20): SearchItem[] {
  const typed = query.trim();
  const q = typed.toLowerCase();
  if (q === '') return [];
  const hits: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    const score = matchScore(item, q);
    if (score !== -1) hits.push({ item, score: score === 0 && item.label !== typed ? 0.5 : score });
  }
  hits.sort(
    (a, b) =>
      a.score - b.score || KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind] || a.item.label.length - b.item.label.length || cmp(a.item.label, b.item.label),
  );
  return hits.slice(0, limit).map((h) => h.item);
}

export interface ViolationGroup {
  /** The rule id, the bucket name, or '' for violations that concern no bucket. */
  key: string;
  items: Violation[];
}

/** Groups violations by rule (in rule order) or by bucket (by name, '' last). A violation of two buckets shows in both. */
export function groupViolations(list: readonly Violation[], by: 'rule' | 'bucket', filter: string, text: (v: Violation) => string): ViolationGroup[] {
  const f = filter.trim().toLowerCase();
  const groups = new Map<string, Violation[]>();
  for (const v of list) {
    if (f !== '' && !text(v).toLowerCase().includes(f)) continue;
    const keys = by === 'rule' ? [v.rule] : violationBuckets(v);
    for (const key of keys.length > 0 ? new Set(keys) : ['']) {
      const g = groups.get(key);
      if (g) g.push(v);
      else groups.set(key, [v]);
    }
  }
  const rank = (key: string) => (by === 'rule' ? (RULE_IDS as readonly string[]).indexOf(key) : 0);
  return [...groups.entries()]
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => rank(a.key) - rank(b.key) || (a.key === '' ? 1 : b.key === '' ? -1 : cmp(a.key, b.key)));
}

export interface Change {
  /** A bucket name, an edge id `from->to`, or a violationKey. */
  id: string;
  kind: 'bucket' | 'edge' | 'violation';
  text: string;
}

/** What is new in `next`: buckets, edges added, removed or with a new state, and violations. */
export function diffProject(old: SnapshotProject | undefined, next: SnapshotProject): Change[] {
  const changes: Change[] = [];
  const oldBuckets = new Set(old?.buckets.map((b) => b.name));
  for (const b of next.buckets) if (!oldBuckets.has(b.name)) changes.push({ id: b.name, kind: 'bucket', text: `new bucket ${b.name}` });
  const oldEdges = new Map(old?.edges.map((e) => [edgeId(e.from, e.to), e]));
  for (const e of next.edges) {
    const id = edgeId(e.from, e.to);
    const before = oldEdges.get(id);
    oldEdges.delete(id);
    const label = `${e.from} -> ${e.to}`;
    if (before === undefined) changes.push({ id, kind: 'edge', text: e.state === 'undeclared' ? `new undeclared import ${label}` : `new dependency ${label}` });
    else if (before.state !== e.state) changes.push({ id, kind: 'edge', text: `${label} is now ${e.state}` });
  }
  for (const [id, e] of oldEdges) changes.push({ id, kind: 'edge', text: `removed dependency ${e.from} -> ${e.to}` });
  const oldKeys = new Set(old?.violations.map(violationKey));
  const nextKeys = new Set<string>();
  for (const v of next.violations) {
    const id = violationKey(v);
    nextKeys.add(id);
    if (!oldKeys.has(id)) changes.push({ id, kind: 'violation', text: `new pending: ${renderSummary(v)}` });
  }
  // Same id as the new item, so an item that comes and goes within one session shows its latest state only.
  for (const v of old?.violations ?? []) {
    const id = violationKey(v);
    if (!nextKeys.has(id)) changes.push({ id, kind: 'violation', text: `resolved: ${renderSummary(v)}` });
  }
  return changes;
}

const isConfigInvalid = (v: Violation) => v.rule === 'config-invalid';

/** A project without an architecture to compare against: not checked, or its config did not parse. */
const isEmptyBaseline = (p: SnapshotProject | undefined) => p === undefined || p.environment !== null || p.violations.some(isConfigInvalid);

/**
 * diffProject for every project of `next`, by project path. Projects without changes are left out, and so are
 * projects that `old` lacks or could not read: against an empty project every bucket would look new.
 */
export function diffSnapshots(old: SnapshotV2, next: SnapshotV2): Map<string, Change[]> {
  const before = new Map(old.projects.map((p) => [p.path, p]));
  const out = new Map<string, Change[]>();
  for (const p of next.projects) {
    const prev = before.get(p.path);
    if (isEmptyBaseline(prev)) continue;
    const changes = diffProject(prev, p);
    if (changes.length > 0) out.set(p.path, changes);
  }
  return out;
}

/**
 * The snapshot the page shows. A half-saved config makes a project config-invalid with no buckets; such a project is
 * replaced by its last valid version from `lastGood`, when there is one, and its config errors are returned for a
 * banner. `lastGood` is updated with every valid project of `next`.
 */
export function holdInvalid(next: SnapshotV2, lastGood: Map<string, SnapshotProject>): { shown: SnapshotV2; invalid: Map<string, Violation[]> } {
  const invalid = new Map<string, Violation[]>();
  const projects = next.projects.map((p) => {
    const errors = p.violations.filter(isConfigInvalid);
    if (errors.length === 0) {
      lastGood.set(p.path, p);
      return p;
    }
    invalid.set(p.path, errors);
    return lastGood.get(p.path) ?? p;
  });
  const paths = new Set(next.projects.map((p) => p.path));
  if (invalid.size === 0) {
    // Every config is valid, so a project that is gone was removed on purpose.
    for (const path of lastGood.keys()) if (!paths.has(path)) lastGood.delete(path);
  } else {
    // A broken config cannot list its nested projects; keep the ones it listed when it was valid.
    for (const [path, p] of lastGood) if (!paths.has(path)) projects.push(p);
  }
  return { shown: { ...next, projects }, invalid };
}

/** The buckets a selection involves, which the bucket list highlights: the bucket, both ends of an edge, a file's owners. */
export function selectionBuckets(selection: Selection, owner: FileOwner | undefined): string[] {
  switch (selection.kind) {
    case 'none':
      return [];
    case 'bucket':
      return [selection.name];
    case 'export':
      return [selection.bucket];
    case 'edge':
      return [selection.from, selection.to];
    case 'file':
      return owner?.state === 'bucket' ? [owner.bucket] : owner?.state === 'overlap' ? [...owner.buckets] : [];
  }
}

/** Where a pending item leads: its dependency when the project has that edge, else its first bucket, else nowhere. */
export function violationTarget(index: ProjectIndex, v: Violation): Selection | null {
  if ('from' in v && 'to' in v && index.edges.has(edgeId(v.from, v.to))) return { kind: 'edge', from: v.from, to: v.to };
  const name = violationBuckets(v).find((b) => index.buckets.has(b));
  return name === undefined ? null : { kind: 'bucket', name };
}

/** Files of each owner filter, for the counts next to the filter's options. */
export function ownerCounts(project: SnapshotProject): Record<OwnerFilter, number> {
  const counts: Record<OwnerFilter, number> = { all: 0, bucket: 0, ignored: 0, unowned: 0, overlap: 0 };
  for (const g of project.files) {
    counts.all += g.names.length;
    counts[g.owner.state] += g.names.length;
  }
  return counts;
}

/** The heading name of a project: the folder name for the root project, else its path. */
export const projectName = (path: string, rootName: string) => (path === '.' ? rootName : path);

/** True when an import of package `name` names a path inside it (`lodash/merge`, `fs/promises` of `node:fs`). */
export const isSubpath = (name: string, specifier: string) => specifier.replace(/^node:/, '') !== name.replace(/^node:/, '');

/** An exported name of a bucket and the public file that exports it. With two public files that export the same name, the first. */
export function findExport(bucket: SnapshotBucket | undefined, name: string): { file: string; e: SnapshotExport } | null {
  for (const pub of bucket?.public ?? []) {
    const e = pub.exports.find((x) => x.name === name);
    if (e) return { file: pub.file, e };
  }
  return null;
}

export interface SplitGroup {
  /** Dependents, sorted. */
  buckets: string[];
  /** The exported names they use, sorted. */
  names: string[];
}

/**
 * The SKILL's split rule: a bucket may want to split when its dependents use disjoint parts of its public files.
 * Dependents that share a name land in the same group. Returns the groups when there are two or more, else null. A
 * dependent without named imports (a namespace or side-effect import) could use anything, so then it returns null.
 */
export function splitGroups(bucket: SnapshotBucket): SplitGroup[] | null {
  if (bucket.dependents.length < 2 || bucket.dependents.some((d) => d.names.length === 0)) return null;
  // Union-find over the dependents, joined through each name.
  const parent = bucket.dependents.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  bucket.dependents.forEach((d, i) => {
    for (const name of d.names) {
      const j = owner.get(name);
      if (j === undefined) owner.set(name, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, { buckets: Set<string>; names: Set<string> }>();
  bucket.dependents.forEach((d, i) => {
    const root = find(i);
    const g = groups.get(root) ?? { buckets: new Set(), names: new Set() };
    groups.set(root, g);
    g.buckets.add(d.bucket);
    for (const n of d.names) g.names.add(n);
  });
  if (groups.size < 2) return null;
  return [...groups.values()]
    .map((g) => ({ buckets: [...g.buckets].sort(cmp), names: [...g.names].sort(cmp) }))
    .sort((a, b) => cmp(a.buckets[0]!, b.buckets[0]!));
}

/** Text that `c` copies: a file path, `file:line` for an export or a dependency, or the bucket name. */
export function copyText(index: ProjectIndex, s: Selection): string | null {
  switch (s.kind) {
    case 'none':
      return null;
    case 'bucket':
      return s.name;
    case 'file':
      return s.path;
    case 'edge': {
      const first = index.edges.get(edgeId(s.from, s.to))?.imports[0];
      return first ? `${first.file}:${first.line}` : `${s.from} -> ${s.to}`;
    }
    case 'export': {
      const found = findExport(index.buckets.get(s.bucket), s.name);
      return found ? `${found.file}:${found.e.line}` : s.name;
    }
  }
}

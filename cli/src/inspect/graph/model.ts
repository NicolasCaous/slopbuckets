// What the graph view and the SVG export compute from a project: layout input, pending counts, accessible names,
// the focus neighborhood and the paths between two buckets. Pure, no DOM.
import { violationBuckets, type SnapshotEdge, type SnapshotProject } from '../../contract/browser.js';
import { nodeWidth, type LayoutInput } from './layout.js';

/** Same format as GraphState.changed. */
export const edgeId = (from: string, to: string) => `${from}->${to}`;

const numbers = new Intl.NumberFormat('en-US');
export const formatNumber = (n: number) => numbers.format(n);
export const formatCount = (count: number, one: string, many: string) => `${numbers.format(count)} ${count === 1 ? one : many}`;

export function pendingCounts(project: SnapshotProject): Map<string, number> {
  const counts = new Map<string, number>();
  for (const violation of project.violations) {
    for (const bucket of new Set(violationBuckets(violation))) counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return counts;
}

export function nodeName(name: string, fileCount: number, pending: number): string {
  const parts = [name, formatCount(fileCount, 'file', 'files')];
  if (pending > 0) parts.push(`${numbers.format(pending)} pending`);
  return parts.join(', ');
}

export function edgeName(edge: SnapshotEdge): string {
  const imports = formatCount(edge.imports.length, 'import', 'imports');
  if (edge.state === 'used') return `${edge.from} depends on ${edge.to}, ${imports}`;
  if (edge.state === 'unused') return `${edge.from} depends on ${edge.to}, declared but not imported`;
  return `${edge.from} imports ${edge.to} without declaring it, ${imports}`;
}

/** Layout input for the buckets in `visible` (all when null) and the edges between them. */
export function layoutInput(project: SnapshotProject, visible: ReadonlySet<string> | null): LayoutInput {
  return {
    nodes: project.buckets.filter((b) => !visible || visible.has(b.name)).map((b) => ({ id: b.name, width: nodeWidth(b.name) })),
    edges: project.edges
      .filter((e) => !visible || (visible.has(e.from) && visible.has(e.to)))
      .map((e) => ({ from: e.from, to: e.to, declared: e.state !== 'undeclared' })),
  };
}

/** Cache key of a layout: the buckets and edges it lays out. */
export const layoutKey = (input: LayoutInput) =>
  input.nodes.map((n) => n.id).join(',') + '|' + input.edges.map((e) => `${edgeId(e.from, e.to)}${e.declared ? '' : '!'}`).join(',');

export interface Adjacency {
  /** Dependencies of each bucket. */
  down: Map<string, string[]>;
  /** Dependents of each bucket. */
  up: Map<string, string[]>;
}

export function adjacency(project: SnapshotProject): Adjacency {
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const b of project.buckets) down.set(b.name, []), up.set(b.name, []);
  for (const e of project.edges) down.get(e.from)?.push(e.to), up.get(e.to)?.push(e.from);
  return { down, up };
}

/** Buckets reachable from `seeds` in at most `depth` steps along `next`, the seeds included. */
function reach(seeds: string[], next: Map<string, string[]>, depth: number): Set<string> {
  const seen = new Set(seeds.filter((s) => next.has(s)));
  let frontier = [...seen];
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const following: string[] = [];
    for (const v of frontier) for (const w of next.get(v) ?? []) if (!seen.has(w)) seen.add(w), following.push(w);
    frontier = following;
  }
  return seen;
}

/** The seeds with their dependencies and dependents up to `depth` levels away. */
export function focusNeighborhood(graph: Adjacency, seeds: string[], depth: number): Set<string> {
  const result = reach(seeds, graph.down, depth);
  for (const v of reach(seeds, graph.up, depth)) result.add(v);
  return result;
}

/** Every bucket and edge on a dependency path between `a` and `b`, in either direction. Empty when none exists. */
export function pathsBetween(graph: Adjacency, a: string, b: string): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const [start, goal] of [[a, b], [b, a]] as const) {
    const fromStart = reach([start], graph.down, Infinity);
    const toGoal = reach([goal], graph.up, Infinity);
    if (start === goal || !fromStart.has(goal)) continue;
    for (const v of fromStart) {
      if (!toGoal.has(v)) continue;
      nodes.add(v);
      for (const w of graph.down.get(v)!) if (toGoal.has(w)) edges.add(edgeId(v, w));
    }
  }
  return { nodes, edges };
}

/** What the graph draws while a pair is set: the two buckets and every bucket on a path between them. */
export function pairBuckets(graph: Adjacency, a: string, b: string): Set<string> {
  const visible = pathsBetween(graph, a, b).nodes;
  for (const name of [a, b]) if (graph.down.has(name)) visible.add(name);
  return visible;
}

/**
 * The dependency paths between `a` and `b` as bucket lists, from the bucket that depends on the other, shortest first.
 * At most `limit` paths; `more` tells whether others exist. The graph is acyclic, but a cycle in a broken config
 * would not loop: a path never visits a bucket twice.
 */
export function listPaths(graph: Adjacency, a: string, b: string, limit = 50): { paths: string[][]; more: boolean } {
  const paths: string[][] = [];
  let more = false;
  for (const [start, goal] of [[a, b], [b, a]] as const) {
    if (start === goal) continue;
    const toGoal = reach([goal], graph.up, Infinity);
    if (!toGoal.has(start)) continue;
    const path = [start];
    const walk = (v: string): void => {
      for (const w of graph.down.get(v) ?? []) {
        if (more || !toGoal.has(w) || path.includes(w)) continue;
        if (paths.length === limit) {
          more = true;
          return;
        }
        path.push(w);
        if (w === goal) paths.push([...path]);
        else walk(w);
        path.pop();
      }
    };
    walk(start);
  }
  paths.sort((x, y) => x.length - y.length);
  return { paths, more };
}

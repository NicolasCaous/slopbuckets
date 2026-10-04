// Bucket graph: an edge goes from the importing bucket to the origin bucket of each DMZ symbol it imports.
import { resolveOrigin, type Model } from '../model.js';
import type { Violation } from '../types.js';
import type { DmzUse } from './imports.js';

export interface Edge {
  from: string;
  to: string;
  file: string;
  line: number;
  symbol: string;
  via: string;
  /** DMZ files the symbol passes through, from the imported DMZ file to the last one before the declaring `_/` file. */
  chain: string[];
}

export function buildEdges(model: Model, uses: DmzUse[]): Edge[] {
  const edges: Edge[] = [];
  for (const use of uses) {
    for (const name of use.names) {
      if (!model.exports.get(use.target)?.has(name)) continue;
      const origin = resolveOrigin(model, use.target, name);
      if (origin.bucket === null || origin.bucket === use.bucket) continue;
      const chain = origin.chain.slice(0, -1);
      edges.push({ from: use.bucket, to: origin.bucket, file: use.file, line: use.line, symbol: name, via: use.target, chain });
    }
  }
  return edges;
}

/** Strongly connected components with more than one node (Tarjan). */
export function cyclicComponents(nodes: string[], adjacency: Map<string, Set<string>>): string[][] {
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

/** Shortest path from `start` to `goal` using only nodes in `allowed`, both ends included. */
function shortestPath(start: string, goal: string, adjacency: Map<string, Set<string>>, allowed: Set<string>): string[] {
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === goal) break;
    for (const next of [...(adjacency.get(node) ?? [])].sort()) {
      if (!allowed.has(next) || previous.has(next)) continue;
      previous.set(next, node);
      queue.push(next);
    }
  }
  const path: string[] = [];
  for (let node: string | null | undefined = goal; node != null; node = previous.get(node)) path.unshift(node);
  return path;
}

interface CycleEdge {
  edge: Edge;
  /** The cycle that contains the edge, starting and ending at `edge.from`. */
  cycle: string[];
}

/** Every edge that lies on a cycle of the bucket graph. */
function cycleEdges(model: Model, uses: DmzUse[]): CycleEdge[] {
  const edges = buildEdges(model, uses);
  const adjacency = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from)!.add(edge.to);
  }
  const out: CycleEdge[] = [];
  for (const component of cyclicComponents([...nodes].sort(), adjacency)) {
    const members = new Set(component);
    for (const edge of edges) {
      if (!members.has(edge.from) || !members.has(edge.to)) continue;
      out.push({ edge, cycle: [edge.from, ...shortestPath(edge.to, edge.from, adjacency, members)] });
    }
  }
  return out;
}

const ONE_WAY =
  'Buckets must depend on each other in one direction only. Remove one of the imports in the cycle, or move the code both buckets need into one of them so every import points the same way.';

/**
 * One violation per file and cycle edge it creates. The message names the whole cycle.
 * With `dmzFile`, each cycle edge whose symbol passes through that DMZ file is also reported on it, so
 * `check --file` on a DMZ edit that closes a cycle finds the cycle.
 */
export function checkCycles(model: Model, uses: DmzUse[], dmzFile?: string): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const onCycles = cycleEdges(model, uses);
  for (const { edge, cycle } of onCycles) {
    const key = JSON.stringify([edge.file, edge.from, edge.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({
      rule: 'graph-cycle',
      file: edge.file,
      line: edge.line,
      message: `Bucket cycle: ${cycle.join(' -> ')}. This file adds the edge ${edge.from} -> ${edge.to} by importing \`${edge.symbol}\` (declared in ${edge.to}) from ${edge.via}. ${ONE_WAY}`,
    });
  }
  if (dmzFile !== undefined) {
    for (const { edge, cycle } of onCycles) {
      if (!edge.chain.includes(dmzFile)) continue;
      const key = JSON.stringify([dmzFile, edge.from, edge.to, edge.symbol]);
      if (seen.has(key)) continue;
      seen.add(key);
      const line = model.exports.get(dmzFile)?.get(edge.symbol)?.line;
      violations.push({
        rule: 'graph-cycle',
        file: dmzFile,
        ...(line !== undefined ? { line } : {}),
        message: `Bucket cycle: ${cycle.join(' -> ')}. This DMZ file re-exports \`${edge.symbol}\` (declared in ${edge.to}), and ${edge.file} imports it from ${edge.via}, which adds the edge ${edge.from} -> ${edge.to}. ${ONE_WAY} Removing \`${edge.symbol}\` from this file also breaks the cycle.`,
      });
    }
  }
  return violations;
}

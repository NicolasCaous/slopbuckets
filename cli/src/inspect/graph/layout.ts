// Layered layout of the bucket graph. Pure and synchronous, so it runs the same in the Web Worker (worker.ts),
// on the main thread and in Node for `--export svg`.
//
// 1. Cycle breaking: declared edges first, then undeclared ones; an edge that would close a cycle is kept out of the
//    layering and drawn reversed (only undeclared imports can do that in a valid config).
// 2. Layering by longest path: a bucket sits one layer above its deepest dependency, so every other edge goes down.
// 3. Edges that span several layers get one dummy vertex per layer they cross.
// 4. Crossing reduction: barycenter sweeps down and up, keeping the order with the fewest crossings.
// 5. x coordinates: each layer is pulled toward the mean x of its neighbors with an isotonic regression (pool adjacent
//    violators), which keeps the order and the minimum gaps.

export const NODE_HEIGHT = 44;
export const LAYER_GAP = 64;
const CHAR_WIDTH = 7.8; // 13px monospace
const NODE_GAP = 24;
const DUMMY_GAP = 10;
const SWEEPS = 16;
const X_ROUNDS = 8;

/** Width of a node: room for the name, and at least for a count line like "12,345 files". */
export function nodeWidth(name: string): number {
  return Math.ceil(Math.max(name.length, 12) * CHAR_WIDTH + 24);
}

export interface LayoutInput {
  nodes: { id: string; width: number }[];
  /** `declared` edges win when an edge has to be reversed to break a cycle. */
  edges: { from: string; to: string; declared: boolean }[];
}

export interface LayoutNode {
  id: string;
  /** Top left corner. */
  x: number;
  y: number;
  width: number;
  layer: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** From the bottom of `from` to the top of `to`, or from the top of `from` to the bottom of `to` when reversed. */
  points: [number, number][];
  /** True when the edge goes up because it closes a cycle. */
  reversed: boolean;
}

export interface Layout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Node ids of each layer, left to right. */
  layers: string[][];
}

interface Vertex {
  width: number;
  layer: number;
  /** Node index, or -1 for a dummy. */
  node: number;
  up: number[];
  down: number[];
  x: number;
}

/** An edge between node indexes. */
interface IndexEdge {
  from: number;
  to: number;
  declared: boolean;
}

export function computeLayout(input: LayoutInput): Layout {
  const n = input.nodes.length;
  const index = new Map(input.nodes.map((node, i) => [node.id, i]));
  const edges = input.edges
    .map((e) => ({ from: index.get(e.from)!, to: index.get(e.to)!, declared: e.declared }))
    .filter((e) => e.from !== undefined && e.to !== undefined && e.from !== e.to);
  const { out, reversed } = breakCycles(n, edges);
  const { vertices, maxHeight } = layerVertices(input, out);
  const chains = addChains(edges, reversed, vertices);
  const layers = orderLayers(vertices, maxHeight);
  placeX(vertices, layers);
  return toLayout(input, edges, reversed, chains, vertices, layers);
}

/** 1. Cycle breaking: the edges kept for the layering, by node, and which edges are drawn reversed. */
function breakCycles(n: number, edges: IndexEdge[]): { out: number[][]; reversed: boolean[] } {
  const out: number[][] = Array.from({ length: n }, () => []);
  const reaches = (start: number, goal: number): boolean => {
    const seen = new Uint8Array(n);
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (v === goal) return true;
      for (const w of out[v]!) if (!seen[w]) (seen[w] = 1), stack.push(w);
    }
    return false;
  };
  const reversed = new Array<boolean>(edges.length).fill(false);
  const order = edges.map((_, i) => i).sort((a, b) => Number(edges[b]!.declared) - Number(edges[a]!.declared) || a - b);
  // ponytail: one DFS per edge, O(E * (V + E)); about 20 ms for 1,230 edges.
  for (const i of order) {
    const e = edges[i]!;
    if (reaches(e.to, e.from)) reversed[i] = true;
    else out[e.from]!.push(e.to);
  }
  return { out, reversed };
}

/** 2. Layering. height = longest path down to a bucket with no dependencies. */
function layerVertices(input: LayoutInput, out: number[][]): { vertices: Vertex[]; maxHeight: number } {
  const n = input.nodes.length;
  const height = new Int32Array(n).fill(-1);
  const heightOf = (v: number): number => {
    if (height[v]! >= 0) return height[v]!;
    let h = 0;
    for (const w of out[v]!) h = Math.max(h, heightOf(w) + 1);
    return (height[v] = h);
  };
  let maxHeight = 0;
  for (let v = 0; v < n; v++) maxHeight = Math.max(maxHeight, heightOf(v));
  const vertices: Vertex[] = input.nodes.map((node, i) => ({
    width: node.width,
    layer: maxHeight - height[i]!,
    node: i,
    up: [],
    down: [],
    x: 0,
  }));
  return { vertices, maxHeight };
}

/** 3. Dummy vertices. Each edge becomes a chain going down, from the upper end to the lower end. */
function addChains(edges: IndexEdge[], reversed: boolean[], vertices: Vertex[]): number[][] {
  return edges.map((e, i) => {
    const [top, bottom] = reversed[i] ? [e.to, e.from] : [e.from, e.to];
    const chain = [top];
    for (let layer = vertices[top]!.layer + 1; layer < vertices[bottom]!.layer; layer++) {
      vertices.push({ width: 0, layer, node: -1, up: [], down: [], x: 0 });
      chain.push(vertices.length - 1);
    }
    chain.push(bottom);
    for (let k = 1; k < chain.length; k++) {
      vertices[chain[k - 1]!]!.down.push(chain[k]!);
      vertices[chain[k]!]!.up.push(chain[k - 1]!);
    }
    return chain;
  });
}

/** The crossings between each pair of adjacent layers, with the lower ends of each layer counted by a Fenwick tree. */
function countCrossings(vertices: Vertex[], layers: number[][], position: Float64Array): number {
  let total = 0;
  for (let l = 0; l + 1 < layers.length; l++) {
    const pairs: [number, number][] = [];
    for (const v of layers[l]!) for (const w of vertices[v]!.down) pairs.push([position[v]!, position[w]!]);
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const size = layers[l + 1]!.length;
    const tree = new Int32Array(size + 1);
    for (let k = 0; k < pairs.length; k++) {
      let greater = k;
      for (let i = pairs[k]![1] + 1; i > 0; i -= i & -i) greater -= tree[i]!;
      total += greater;
      for (let i = pairs[k]![1] + 1; i <= size; i += i & -i) tree[i]!++;
    }
  }
  return total;
}

/** 4. Crossing reduction: barycenter sweeps down and up, keeping the order with the fewest crossings. */
function orderLayers(vertices: Vertex[], maxHeight: number): number[][] {
  const layers: number[][] = Array.from({ length: maxHeight + 1 }, () => []);
  for (let v = 0; v < vertices.length; v++) layers[vertices[v]!.layer]!.push(v);
  const position = new Float64Array(vertices.length);
  const setPositions = (layer: number[]) => layer.forEach((v, i) => (position[v] = i));
  layers.forEach(setPositions);
  const reorder = (layer: number[], neighbors: (v: Vertex) => number[]) => {
    const key = new Map<number, number>();
    for (const v of layer) {
      const list = neighbors(vertices[v]!);
      key.set(v, list.length === 0 ? position[v]! : list.reduce((sum, w) => sum + position[w]!, 0) / list.length);
    }
    layer.sort((a, b) => key.get(a)! - key.get(b)! || position[a]! - position[b]!);
    setPositions(layer);
  };
  let best = layers.map((layer) => [...layer]);
  let bestCrossings = countCrossings(vertices, layers, position);
  for (let sweep = 0; sweep < SWEEPS && bestCrossings > 0; sweep++) {
    if (sweep % 2 === 0) for (let l = 1; l < layers.length; l++) reorder(layers[l]!, (v) => v.up);
    else for (let l = layers.length - 2; l >= 0; l--) reorder(layers[l]!, (v) => v.down);
    const count = countCrossings(vertices, layers, position);
    if (count < bestCrossings) (bestCrossings = count), (best = layers.map((layer) => [...layer]));
  }
  return best;
}

const gap = (a: Vertex, b: Vertex) => (a.node < 0 && b.node < 0 ? DUMMY_GAP : a.node < 0 || b.node < 0 ? (DUMMY_GAP + NODE_GAP) / 2 : NODE_GAP);

/** 5. x coordinates, as centers: each layer pulled toward the mean x of its neighbors, keeping order and gaps. */
function placeX(vertices: Vertex[], layers: number[][]): void {
  for (const layer of layers) {
    let x = 0;
    layer.forEach((v, i) => {
      const vertex = vertices[v]!;
      if (i > 0) x += vertices[layer[i - 1]!]!.width / 2 + gap(vertices[layer[i - 1]!]!, vertex) + vertex.width / 2;
      vertex.x = x;
    });
  }
  const place = (layer: number[], neighbors: (v: Vertex) => number[]) => {
    // Minimize the squared distance to the desired x under x[i+1] >= x[i] + spacing[i]: subtract the cumulative
    // spacing and the constraint becomes "non-decreasing", which pool adjacent violators solves exactly.
    const offsets: number[] = [];
    const targets: number[] = [];
    let offset = 0;
    layer.forEach((v, i) => {
      const vertex = vertices[v]!;
      if (i > 0) offset += vertices[layer[i - 1]!]!.width / 2 + gap(vertices[layer[i - 1]!]!, vertex) + vertex.width / 2;
      const list = neighbors(vertex);
      const desired = list.length === 0 ? vertex.x : list.reduce((sum, w) => sum + vertices[w]!.x, 0) / list.length;
      offsets.push(offset);
      targets.push(desired - offset);
    });
    const blocks: { sum: number; count: number }[] = [];
    for (const t of targets) {
      blocks.push({ sum: t, count: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count) {
        const last = blocks.pop()!;
        blocks[blocks.length - 1]!.sum += last.sum;
        blocks[blocks.length - 1]!.count += last.count;
      }
    }
    let i = 0;
    for (const block of blocks) for (let k = 0; k < block.count; k++, i++) vertices[layer[i]!]!.x = block.sum / block.count + offsets[i]!;
  };
  for (let round = 0; round < X_ROUNDS; round++) {
    if (round % 2 === 0) for (let l = 1; l < layers.length; l++) place(layers[l]!, (v) => v.up);
    else for (let l = layers.length - 2; l >= 0; l--) place(layers[l]!, (v) => v.down);
  }
  for (const layer of layers) place(layer, (v) => [...v.up, ...v.down]);
}

const layerY = (layer: number) => layer * (NODE_HEIGHT + LAYER_GAP);
const round1 = (value: number) => Math.round(value * 10) / 10;

/** The nodes, the edges with their points and the layers, shifted so the leftmost vertex starts at x 0. */
function toLayout(input: LayoutInput, edges: IndexEdge[], reversed: boolean[], chains: number[][], vertices: Vertex[], layers: number[][]): Layout {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const v of vertices) (minX = Math.min(minX, v.x - v.width / 2)), (maxX = Math.max(maxX, v.x + v.width / 2));
  if (vertices.length === 0) minX = maxX = 0;

  // Ports: the edges leaving the bottom (or entering the top) of a node spread over its middle 60%, left to right.
  const port = (v: number, other: number, side: 'up' | 'down'): number => {
    const vertex = vertices[v]!;
    if (vertex.node < 0) return vertex.x;
    const list = vertex[side];
    if (list.length < 2) return vertex.x;
    const sorted = [...list].sort((a, b) => vertices[a]!.x - vertices[b]!.x || a - b);
    return vertex.x - vertex.width * 0.3 + (vertex.width * 0.6 * (sorted.indexOf(other) + 0.5)) / list.length;
  };

  const layoutEdges: LayoutEdge[] = edges.map((e, i) => {
    const chain = chains[i]!;
    const points: [number, number][] = [];
    for (let k = 0; k < chain.length; k++) {
      const v = chain[k]!;
      const top = layerY(vertices[v]!.layer);
      if (k > 0) points.push([port(v, chain[k - 1]!, 'up'), top]);
      if (k < chain.length - 1) points.push([port(v, chain[k + 1]!, 'down'), top + NODE_HEIGHT]);
    }
    if (reversed[i]) points.reverse();
    return {
      from: input.nodes[e.from]!.id,
      to: input.nodes[e.to]!.id,
      points: points.map(([x, y]) => [round1(x - minX), y]),
      reversed: reversed[i]!,
    };
  });

  return {
    width: round1(maxX - minX),
    height: layers.length === 0 ? 0 : layerY(layers.length - 1) + NODE_HEIGHT,
    nodes: input.nodes.map((node, i) => ({
      id: node.id,
      x: round1(vertices[i]!.x - node.width / 2 - minX),
      y: layerY(vertices[i]!.layer),
      width: node.width,
      layer: vertices[i]!.layer,
    })),
    edges: layoutEdges,
    layers: layers.map((layer) => layer.filter((v) => vertices[v]!.node >= 0).map((v) => input.nodes[vertices[v]!.node]!.id)),
  };
}

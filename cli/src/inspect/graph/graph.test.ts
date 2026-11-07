import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { SnapshotProject, SnapshotV2 } from '../../contract/snapshot.js';
import { NODE_HEIGHT, computeLayout } from './layout.js';
import { adjacency, edgeName, focusNeighborhood, layoutInput, listPaths, nodeName, pairBuckets, pathsBetween, pendingCounts } from './model.js';
import { renderGraphSvg } from './svg.js';

const load = (name: string): SnapshotV2 =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../examples/fixtures/snapshots/${name}.json`, import.meta.url)), 'utf8'));
const small = load('small');
const root = (snapshot: SnapshotV2) => snapshot.projects[0]!;

function project(edges: [string, string, 'used' | 'unused' | 'undeclared'][]): SnapshotProject {
  const names = [...new Set(edges.flat().filter((s) => !['used', 'unused', 'undeclared'].includes(s)))].sort();
  return {
    path: '.',
    environment: null,
    ignore: [],
    projects: [],
    buckets: names.map((name) => ({ name, purpose: '', files: [], fileCount: 1, public: [], external: null, dependsOn: [], packages: [], dependents: [] })),
    edges: edges.map(([from, to, state]) => ({ from, to, state, reason: null, imports: [] })),
    files: [],
    violations: [],
    advice: [],
  };
}

describe('computeLayout', () => {
  for (const name of ['small', 'medium', 'large']) {
    it(`keeps the layout properties on the ${name} fixture`, () => {
      const p = root(load(name));
      const layout = computeLayout(layoutInput(p, null));
      const nodes = new Map(layout.nodes.map((n) => [n.id, n]));
      expect(nodes.size).toBe(p.buckets.length);
      // Every edge goes down a layer, except the few undeclared imports that close a cycle, which go up.
      for (const e of layout.edges) {
        const [from, to] = [nodes.get(e.from)!, nodes.get(e.to)!];
        if (e.reversed) {
          expect(p.edges.find((x) => x.from === e.from && x.to === e.to)!.state).toBe('undeclared');
          expect(from.layer).toBeGreaterThan(to.layer);
        } else expect(from.layer).toBeLessThan(to.layer);
        expect(e.points[0]![1]).toBe(e.reversed ? from.y : from.y + NODE_HEIGHT);
        expect(e.points.at(-1)![1]).toBe(e.reversed ? to.y + NODE_HEIGHT : to.y);
      }
      // No two nodes of a layer overlap, and layers keep their order left to right.
      for (const layer of layout.layers) {
        for (let i = 1; i < layer.length; i++) {
          const [a, b] = [nodes.get(layer[i - 1]!)!, nodes.get(layer[i]!)!];
          expect(a.y).toBe(b.y);
          expect(a.x + a.width).toBeLessThanOrEqual(b.x);
        }
      }
      expect(computeLayout(layoutInput(p, null))).toEqual(layout);
    });
  }

  it('breaks a cycle at the undeclared edge', () => {
    const layout = computeLayout(layoutInput(project([['a', 'b', 'used'], ['b', 'c', 'used'], ['c', 'a', 'undeclared']]), null));
    expect(layout.layers).toEqual([['a'], ['b'], ['c']]);
    expect(layout.edges.filter((e) => e.reversed).map((e) => `${e.from}->${e.to}`)).toEqual(['c->a']);
  });

  it('removes the crossing of two swapped pairs', () => {
    const layout = computeLayout(layoutInput(project([['a', 'd', 'used'], ['b', 'c', 'used']]), null));
    const x = new Map(layout.nodes.map((n) => [n.id, n.x]));
    expect(x.get('a')! < x.get('b')!).toBe(x.get('d')! < x.get('c')!);
  });
});

describe('focus and paths', () => {
  const p = project([
    ['app', 'api', 'used'],
    ['api', 'auth', 'used'],
    ['auth', 'db', 'used'],
    ['db', 'log', 'used'],
    ['api', 'log', 'unused'],
    ['cli', 'log', 'used'],
  ]);
  const graph = adjacency(p);

  it('keeps the buckets within depth levels up and down', () => {
    expect([...focusNeighborhood(graph, ['auth'], 1)].sort()).toEqual(['api', 'auth', 'db']);
    expect([...focusNeighborhood(graph, ['auth'], 2)].sort()).toEqual(['api', 'app', 'auth', 'db', 'log']);
    // Siblings that only share a dependency stay out.
    expect(focusNeighborhood(graph, ['auth'], 10).has('cli')).toBe(false);
  });

  it('finds every path between two buckets, in either order', () => {
    const paths = pathsBetween(graph, 'log', 'api');
    expect([...paths.nodes].sort()).toEqual(['api', 'auth', 'db', 'log']);
    expect([...paths.edges].sort()).toEqual(['api->auth', 'api->log', 'auth->db', 'db->log']);
    expect(pathsBetween(graph, 'cli', 'app').nodes.size).toBe(0);
  });

  it('lists the paths from the dependent bucket, shortest first, up to a limit', () => {
    expect(listPaths(graph, 'log', 'api')).toEqual({ paths: [['api', 'log'], ['api', 'auth', 'db', 'log']], more: false });
    expect(listPaths(graph, 'api', 'log', 1)).toEqual({ paths: [['api', 'auth', 'db', 'log']], more: true });
    expect(listPaths(graph, 'cli', 'app')).toEqual({ paths: [], more: false });
    expect(listPaths(graph, 'app', 'app')).toEqual({ paths: [], more: false });
  });

  it('draws only the pair and the buckets between them', () => {
    expect([...pairBuckets(graph, 'app', 'db')].sort()).toEqual(['api', 'app', 'auth', 'db']);
    expect([...pairBuckets(graph, 'cli', 'app')].sort()).toEqual(['app', 'cli']);
    expect([...pairBuckets(graph, 'cli', 'gone')]).toEqual(['cli']);
  });
});

describe('names', () => {
  it('gives nodes and edges an accessible name', () => {
    expect(nodeName('billing', 42, 2)).toBe('billing, 42 files, 2 pending');
    expect(nodeName('log', 1, 0)).toBe('log, 1 file');
    const edges = root(small).edges;
    const edge = (from: string, to: string) => edgeName(edges.find((e) => e.from === from && e.to === to)!);
    expect(edge('app', 'auth')).toBe('app depends on auth, 3 imports');
    expect(edge('auth', 'mail')).toBe('auth depends on mail, declared but not imported');
    expect(edge('db', 'app')).toBe('db imports app without declaring it, 1 import');
  });

  it('counts the pending items of each bucket', () => {
    expect(pendingCounts(root(small)).get('auth')).toBeGreaterThan(0);
  });
});

describe('renderGraphSvg', () => {
  it('matches the golden output for the small fixture', async () => {
    await expect(renderGraphSvg(small)).toMatchFileSnapshot('./svg.small.golden.svg');
  });
});

describe('runtime', () => {
  it('bundles for the browser with no Node module and no import from page/ or node/', async () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const result = await build({
      entryPoints: ['index.ts', 'svg.ts', 'worker.ts'].map((f) => path.join(dir, f)),
      bundle: true,
      write: false,
      outdir: 'out',
      platform: 'browser',
      format: 'esm',
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).map((f) => f.replace(/\\/g, '/'));
    expect(inputs.filter((f) => !/src\/inspect\/graph\/|src\/contract\//.test(f))).toEqual([]);
  });
});
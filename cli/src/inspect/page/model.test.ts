import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderFull } from '../../contract/messages.js';
import { snapshotFiles, type SnapshotBucket, type SnapshotProject, type SnapshotV2 } from '../../contract/snapshot.js';
import { violationKey } from '../../contract/violation.js';
import {
  bucketRows,
  buildFileTree,
  cellText,
  copyText,
  diffSnapshots,
  edgeId,
  findExport,
  flattenTree,
  focusBucket,
  graphSelection,
  groupViolations,
  holdInvalid,
  indexProject,
  isSubpath,
  layerOrder,
  matrixCells,
  ownerCounts,
  search,
  searchItems,
  selectionBuckets,
  splitGroups,
  violationTarget,
  type SearchItem,
} from './model.js';
import { DEFAULT_OPTIONS, formatHash, formatOptions, parseHash, parseOptions, type UrlState } from './url.js';

const load = (name: string): SnapshotV2 => JSON.parse(readFileSync(new URL(`../../../../examples/fixtures/snapshots/${name}.json`, import.meta.url), 'utf8'));
const small = load('small');
const root = small.projects[0]!;

const bucket = (name: string, deps: string[] = []): SnapshotBucket => ({
  name,
  purpose: `${name} purpose`,
  files: [],
  fileCount: 0,
  public: [],
  packages: [],
  external: null,
  dependsOn: deps.map((bucket) => ({ bucket, reason: 'r', imports: 1 })),
  dependents: [],
});

describe('url state', () => {
  const cases: UrlState[] = [
    { view: null, selection: { kind: 'none' }, depth: null, project: '.', pair: null },
    { view: 'matrix', selection: { kind: 'none' }, depth: null, project: '.', pair: null },
    { view: null, selection: { kind: 'bucket', name: 'billing' }, depth: null, project: '.', pair: null },
    { view: 'graph', selection: { kind: 'edge', from: 'billing', to: 'payments' }, depth: 2, project: '.', pair: ['a', 'b'] },
    { view: 'files', selection: { kind: 'file', path: 'src/a b/#weird?.ts' }, depth: null, project: 'packages/sdk', pair: null },
    { view: 'pending', selection: { kind: 'export', bucket: 'auth', name: 'default' }, depth: 0, project: '.', pair: null },
  ];
  it.each(cases)('round trips %j', (state) => {
    expect(parseHash(formatHash(state))).toEqual(state);
  });

  it('reads the documented forms', () => {
    expect(parseHash('#/bucket/billing')?.selection).toEqual({ kind: 'bucket', name: 'billing' });
    expect(parseHash('#/edge/billing/payments')?.selection).toEqual({ kind: 'edge', from: 'billing', to: 'payments' });
    expect(parseHash('#/matrix')?.view).toBe('matrix');
    expect(parseHash('#/graph?depth=2')?.depth).toBe(2);
  });

  it('ignores hashes that are not routes and bad values', () => {
    expect(parseHash('#main')).toBeNull();
    expect(parseHash('')?.view).toBeNull();
    expect(parseHash('#/edge/a')?.selection).toEqual({ kind: 'none' });
    expect(parseHash('#/graph?depth=-1&pair=a')).toMatchObject({ depth: null, pair: null });
    expect(parseHash('#/bucket/%E0')?.selection).toEqual({ kind: 'none' });
  });
});

describe('index and matrix', () => {
  it('orders buckets so every declared dependency points down', () => {
    const order = layerOrder(root.buckets);
    const pos = new Map(order.map((n, i) => [n, i]));
    expect(order).toHaveLength(root.buckets.length);
    for (const b of root.buckets) for (const d of b.dependsOn) expect(pos.get(b.name)!).toBeLessThan(pos.get(d.bucket)!);
  });

  it('survives a cycle and sorts ties by name', () => {
    expect(layerOrder([bucket('b', ['a']), bucket('a', ['b']), bucket('c')]).sort()).toEqual(['a', 'b', 'c']);
    expect(layerOrder([bucket('z'), bucket('top', ['z']), bucket('m')])).toEqual(['top', 'm', 'z']);
  });

  it('puts one cell per edge with its state and count', () => {
    const index = indexProject(root);
    const cells = matrixCells(index);
    expect(cells).toHaveLength(root.edges.length);
    for (const c of cells) {
      expect(index.order[c.row]).toBe(c.edge.from);
      expect(index.order[c.col]).toBe(c.edge.to);
    }
    const states = new Set(cells.map((c) => c.edge.state));
    expect(states).toEqual(new Set(['used', 'unused', 'undeclared']));
    const unused = cells.find((c) => c.edge.state === 'unused')!.edge;
    expect(cellText(unused)).toBe('0');
    const used = cells.find((c) => c.edge.state === 'used')!.edge;
    expect(cellText(used)).toBe(String(used.imports.length));
  });

  it('indexes pending items by bucket', () => {
    const index = indexProject(root);
    const undeclared = root.violations.find((v) => v.rule === 'dependency-undeclared')!;
    if (undeclared.rule !== 'dependency-undeclared') throw new Error('fixture');
    expect(index.pending.get(undeclared.from)).toContain(undeclared);
    expect(index.pending.get(undeclared.to)).toContain(undeclared);
  });
});

describe('bucket list', () => {
  const index = indexProject(root);
  it('sorts by name ascending and by counts descending', () => {
    expect(bucketRows(index, 'name', '').map((b) => b.name)).toEqual(root.buckets.map((b) => b.name).sort());
    const byDependents = bucketRows(index, 'dependents', '').map((b) => b.dependents.length);
    expect(byDependents).toEqual([...byDependents].sort((a, b) => b - a));
    const byPending = bucketRows(index, 'pending', '').map((b) => index.pending.get(b.name)?.length ?? 0);
    expect(byPending).toEqual([...byPending].sort((a, b) => b - a));
    const byFiles = bucketRows(index, 'files', '').map((b) => b.fileCount);
    expect(byFiles).toEqual([...byFiles].sort((a, b) => b - a));
    const byDeps = bucketRows(index, 'dependencies', '').map((b) => index.outEdges.get(b.name)?.length ?? 0);
    expect(byDeps).toEqual([...byDeps].sort((a, b) => b - a));
  });

  it('filters by name and purpose', () => {
    expect(bucketRows(index, 'name', 'BILL').map((b) => b.name)).toContain('billing');
    const purpose = root.buckets[0]!.purpose.split(' ')[1]!;
    expect(bucketRows(index, 'name', purpose).length).toBeGreaterThan(0);
    expect(bucketRows(index, 'name', 'no-such-thing')).toEqual([]);
  });

  it('focuses the bucket with the most pending items, else a top bucket with the most dependencies', () => {
    const top = Math.max(...root.buckets.map((b) => index.pending.get(b.name)?.length ?? 0));
    expect(index.pending.get(focusBucket(index)!)!.length).toBe(top);
    const clean = indexProject({ ...root, violations: [] });
    const name = focusBucket(clean)!;
    const noDependents = root.buckets.filter((b) => b.dependents.length === 0);
    const tops = noDependents.length > 0 ? noDependents : root.buckets;
    expect(tops.map((b) => b.name)).toContain(name);
    expect(clean.buckets.get(name)!.dependsOn.length).toBe(Math.max(...tops.map((b) => b.dependsOn.length)));
  });
});

describe('graph selection', () => {
  const file = { kind: 'file', path: 'src/x.ts' } as const;
  const small = indexProject({ ...root, buckets: [bucket('a'), bucket('b', ['a'])], violations: [] });
  const big = indexProject({ ...root, buckets: Array.from({ length: 61 }, (_, i) => bucket(`b${i}`, i === 0 ? ['b1'] : [])), violations: [] });

  it('shows a file as its bucket, the first of two', () => {
    expect(graphSelection(small, file, { state: 'bucket', bucket: 'b' })).toEqual({ kind: 'bucket', name: 'b' });
    expect(graphSelection(small, file, { state: 'overlap', buckets: ['a', 'b'] })).toEqual({ kind: 'bucket', name: 'a' });
    expect(graphSelection(small, { kind: 'edge', from: 'b', to: 'a' }, undefined)).toEqual({ kind: 'edge', from: 'b', to: 'a' });
  });

  it('keeps a large graph in focus mode for a file without a bucket', () => {
    expect(graphSelection(small, file, { state: 'unowned' })).toEqual(file);
    expect(graphSelection(big, file, { state: 'unowned' })).toEqual({ kind: 'bucket', name: focusBucket(big)! });
    expect(graphSelection(big, file, undefined)).toEqual({ kind: 'bucket', name: 'b0' });
  });
});

describe('file tree', () => {
  const project: SnapshotProject = {
    ...root,
    files: [
      { dir: '', owner: { state: 'unowned' }, names: ['README.md'] },
      { dir: 'src/a', owner: { state: 'bucket', bucket: 'a' }, names: ['x.ts', 'z.ts'] },
      { dir: 'src/a', owner: { state: 'overlap', buckets: ['a', 'b'] }, names: ['y.ts'] },
      { dir: 'src/b/deep', owner: { state: 'ignored' }, names: ['gen.ts'] },
    ],
  };
  const tree = buildFileTree(project);

  it('builds folders from grouped files, sorted', () => {
    const rows = flattenTree(tree, new Set(), 'all', '');
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.owner ? '' : `/ ${r.count}`}`)).toEqual([
      'src/ 4',
      '  a/ 3',
      '    x.ts',
      '    y.ts',
      '    z.ts',
      '  b/ 1',
      '    deep/ 1',
      '      gen.ts',
      'README.md',
    ]);
  });

  it('filters by owner state and text, and hides collapsed folders', () => {
    expect(flattenTree(tree, new Set(), 'overlap', '').map((r) => r.path)).toEqual(['src', 'src/a', 'src/a/y.ts']);
    expect(flattenTree(tree, new Set(), 'all', 'GEN').map((r) => r.path)).toEqual(['src', 'src/b', 'src/b/deep', 'src/b/deep/gen.ts']);
    expect(flattenTree(tree, new Set(['src/a']), 'all', '').map((r) => r.path)).toEqual(['src', 'src/a', 'src/b', 'src/b/deep', 'src/b/deep/gen.ts', 'README.md']);
    expect(flattenTree(tree, new Set(['src/a']), 'all', '')[1]).toMatchObject({ collapsed: true, count: 3 });
  });

  it('lists every file of the large fixture once', () => {
    const large = load('large').projects[0]!;
    const rows = flattenTree(buildFileTree(large), new Set(), 'all', '');
    const files = rows.filter((r) => r.owner !== null).map((r) => r.path);
    expect(files.length).toBe([...snapshotFiles(large)].length);
  });
});

describe('search', () => {
  const items = searchItems(root);
  it('ranks exact, prefix, segment and substring matches', () => {
    const first = search(items, 'billing')[0]!;
    expect(first).toMatchObject({ kind: 'bucket', label: 'billing' });
    const labels = search(items, 'auth', 50).map((i) => i.label);
    expect(labels[0]).toBe('auth');
    expect(labels.indexOf('createAuth')).toBeGreaterThan(labels.indexOf('auth'));
  });

  it('finds files by name and limits results', () => {
    const file = [...snapshotFiles(root)][0]!.path;
    const name = file.split('/').pop()!;
    expect(search(items, name, 100).some((i) => i.kind === 'file' && i.label === file)).toBe(true);
    expect(search(items, 's', 5)).toHaveLength(5);
    expect(search(items, '   ')).toEqual([]);
  });

  it('puts the exact match with the same case first', () => {
    const exports = (names: string[]): SearchItem[] =>
      names.map((name) => ({ kind: 'export', label: name, detail: '', selection: { kind: 'export', bucket: 'p', name }, key: name.toLowerCase() }));
    const both = exports(['PaymentsGateway', 'paymentsGateway']);
    expect(search(both, 'paymentsGateway').map((i) => i.label)).toEqual(['paymentsGateway', 'PaymentsGateway']);
    expect(search(both, 'PaymentsGateway').map((i) => i.label)).toEqual(['PaymentsGateway', 'paymentsGateway']);
  });
});

describe('pending groups', () => {
  const text = (v: Parameters<typeof renderFull>[0]) => renderFull(v);
  it('groups by rule in rule order and by bucket with the bucketless group last', () => {
    const byRule = groupViolations(root.violations, 'rule', '', text);
    expect(byRule.reduce((n, g) => n + g.items.length, 0)).toBe(root.violations.length);
    const byBucket = groupViolations(root.violations, 'bucket', '', text);
    const keys = byBucket.map((g) => g.key);
    if (keys.includes('')) expect(keys.at(-1)).toBe('');
    expect(keys.filter((k) => k !== '')).toEqual(keys.filter((k) => k !== '').sort());
  });

  it('filters on the full text', () => {
    const groups = groupViolations(root.violations, 'rule', 'undeclared dependency', text);
    expect(groups.every((g) => g.items.every((v) => renderFull(v).toLowerCase().includes('undeclared dependency')))).toBe(true);
  });
});

describe('snapshot diff', () => {
  it('finds nothing between equal snapshots', () => {
    expect(diffSnapshots(small, structuredClone(small)).size).toBe(0);
  });

  it('marks new buckets, added, removed and changed edges, and new and resolved violations', () => {
    const next = structuredClone(small);
    const p = next.projects[0]!;
    p.buckets.push(bucket('fresh'));
    const removed = p.edges.shift()!;
    const changed = p.edges.find((e) => e.state === 'used')!;
    changed.state = 'undeclared';
    p.edges.push({ from: 'fresh', to: 'billing', state: 'used', reason: 'r', imports: [] });
    const gone = p.violations.shift()!;
    p.violations.push({ rule: 'import-dynamic', project: '.', file: 'src/x.ts', line: 3, call: 'require' });
    const list = diffSnapshots(small, next).get('.')!;
    const ids = new Set(list.map((c) => c.id));
    expect(ids).toEqual(
      new Set([
        'fresh',
        edgeId(removed.from, removed.to),
        edgeId(changed.from, changed.to),
        edgeId('fresh', 'billing'),
        violationKey(p.violations.at(-1)!),
        violationKey(gone),
      ]),
    );
    expect(list.find((c) => c.id === violationKey(gone))!.text).toMatch(/^resolved: /);
    expect(list.find((c) => c.id === violationKey(p.violations.at(-1)!))!.text).toMatch(/^new pending: /);
  });

  const invalidConfig = (p: SnapshotProject): SnapshotProject => ({
    ...p,
    buckets: [],
    edges: [],
    files: [],
    violations: [{ rule: 'config-invalid', project: p.path, problem: { kind: 'json', message: 'Unexpected end of JSON input' } }],
  });

  it('never diffs against a project it could not read or did not have', () => {
    const broken: SnapshotV2 = { ...small, projects: [invalidConfig(root)] };
    expect(diffSnapshots(broken, small).size).toBe(0);
    expect(diffSnapshots({ ...small, projects: [] }, small).size).toBe(0);
  });

  it('holds a config-invalid project at its last valid version', () => {
    const lastGood = new Map<string, SnapshotProject>();
    expect(holdInvalid(small, lastGood).invalid.size).toBe(0);
    expect(lastGood.get('.')).toBe(root);
    const broken: SnapshotV2 = { ...small, projects: [invalidConfig(root)] };
    const held = holdInvalid(broken, lastGood);
    expect(held.shown.projects[0]).toBe(root);
    expect(held.invalid.get('.')!.map((v) => v.rule)).toEqual(['config-invalid']);
    // So a half-saved config adds no change at all.
    expect(diffSnapshots(small, held.shown).size).toBe(0);
    // A broken root config lists no nested project; the last valid ones stay.
    const nested = { ...root, path: 'gone/sdk' };
    holdInvalid({ ...small, projects: [...small.projects, nested] }, lastGood);
    expect(holdInvalid(broken, lastGood).shown.projects.map((p) => p.path)).toContain('gone/sdk');
    // Once every config is valid again, a project that is gone stays gone.
    holdInvalid(small, lastGood);
    expect(holdInvalid(broken, lastGood).shown.projects.map((p) => p.path)).not.toContain('gone/sdk');
    // Without a valid version yet, the invalid project shows as it is.
    const fresh = holdInvalid(broken, new Map());
    expect(fresh.shown.projects[0]!.buckets).toEqual([]);
  });
});

describe('selection helpers', () => {
  const index = indexProject(root);
  const edge = root.edges.find((e) => e.state === 'used')!;

  it('lists the buckets a selection involves', () => {
    expect(selectionBuckets({ kind: 'none' }, undefined)).toEqual([]);
    expect(selectionBuckets({ kind: 'edge', from: 'a', to: 'b' }, undefined)).toEqual(['a', 'b']);
    expect(selectionBuckets({ kind: 'export', bucket: 'a', name: 'x' }, undefined)).toEqual(['a']);
    expect(selectionBuckets({ kind: 'file', path: 'f' }, { state: 'overlap', buckets: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(selectionBuckets({ kind: 'file', path: 'f' }, { state: 'unowned' })).toEqual([]);
  });

  it('leads a pending item to its dependency, else its bucket, else nowhere', () => {
    expect(violationTarget(index, { rule: 'dependency-unused', project: '.', from: edge.from, to: edge.to, reason: 'r' })).toEqual({ kind: 'edge', from: edge.from, to: edge.to });
    expect(violationTarget(index, { rule: 'export-unused', project: '.', bucket: edge.to, name: 'x', public: 'p.ts', line: 1 })).toEqual({ kind: 'bucket', name: edge.to });
    expect(violationTarget(index, { rule: 'import-dynamic', project: '.', file: 'a.ts', line: 1, call: 'import' })).toBeNull();
  });

  it('counts files by owner state', () => {
    const counts = ownerCounts(root);
    expect(counts.all).toBe([...snapshotFiles(root)].length);
    expect(counts.bucket + counts.ignored + counts.unowned + counts.overlap).toBe(counts.all);
  });
});

describe('list options', () => {
  it('round trips and leaves defaults out', () => {
    expect(formatOptions(DEFAULT_OPTIONS)).toBe('');
    const options = { ...DEFAULT_OPTIONS, filter: 'pay ments', sort: 'files', by: 'bucket', owner: 'unowned', table: true } as const;
    expect(parseOptions(formatOptions(options))).toEqual(options);
  });

  it('falls back to the default for unknown values', () => {
    expect(parseOptions('?sort=size&by=file&owner=x&table=yes')).toEqual(DEFAULT_OPTIONS);
  });
});

describe('copy text', () => {
  const index = indexProject(root);
  it('copies file:line for an edge and an export', () => {
    const edge = root.edges.find((e) => e.imports.length > 0)!;
    expect(copyText(index, { kind: 'edge', from: edge.from, to: edge.to })).toBe(`${edge.imports[0]!.file}:${edge.imports[0]!.line}`);
    const b = root.buckets.find((x) => (x.public[0]?.exports.length ?? 0) > 0)!;
    const e = b.public[0]!.exports[0]!;
    expect(copyText(index, { kind: 'export', bucket: b.name, name: e.name })).toBe(`${b.public[0]!.file}:${e.line}`);
    expect(copyText(index, { kind: 'none' })).toBeNull();
  });
});

describe('splitGroups', () => {
  const withDependents = (dependents: { bucket: string; names: string[] }[]): SnapshotBucket => ({ ...bucket('log'), dependents });

  it('finds dependents that use disjoint parts of the public interface', () => {
    const b = withDependents([
      { bucket: 'api', names: ['info', 'warn'] },
      { bucket: 'jobs', names: ['metric'] },
      { bucket: 'web', names: ['warn'] },
    ]);
    expect(splitGroups(b)).toEqual([
      { buckets: ['api', 'web'], names: ['info', 'warn'] },
      { buckets: ['jobs'], names: ['metric'] },
    ]);
  });

  it('says nothing when a name links every dependent, or when one has no named imports', () => {
    expect(splitGroups(withDependents([{ bucket: 'a', names: ['x', 'y'] }, { bucket: 'b', names: ['y'] }, { bucket: 'c', names: ['x'] }]))).toBeNull();
    expect(splitGroups(withDependents([{ bucket: 'a', names: ['x'] }, { bucket: 'b', names: [] }]))).toBeNull();
    expect(splitGroups(withDependents([{ bucket: 'a', names: ['x'] }]))).toBeNull();
  });
});

describe('isSubpath', () => {
  it('is true only when the specifier names a path inside the package', () => {
    expect(isSubpath('lodash', 'lodash')).toBe(false);
    expect(isSubpath('lodash', 'lodash/merge')).toBe(true);
    expect(isSubpath('@scope/pkg', '@scope/pkg')).toBe(false);
    expect(isSubpath('@scope/pkg', '@scope/pkg/x')).toBe(true);
    expect(isSubpath('node:fs', 'fs')).toBe(false);
    expect(isSubpath('node:fs', 'node:fs')).toBe(false);
    expect(isSubpath('node:fs', 'fs/promises')).toBe(true);
    expect(isSubpath('node:fs', 'node:fs/promises')).toBe(true);
  });
});

describe('several public files', () => {
  const b: SnapshotBucket = {
    ...bucket('payments'),
    public: [
      { file: 'src/payments/index.ts', exists: true, exports: [{ name: 'charge', line: 1, typeOnly: false, consumers: [] }] },
      { file: 'src/payments/server.ts', exists: true, exports: [{ name: 'webhook', line: 3, typeOnly: false, consumers: [] }, { name: 'charge', line: 4, typeOnly: false, consumers: [] }] },
    ],
  };
  const project: SnapshotProject = { ...root, buckets: [b], edges: [], files: [], violations: [], advice: [] };

  it('finds an export in any public file, the first one for a repeated name', () => {
    expect(findExport(b, 'webhook')).toEqual({ file: 'src/payments/server.ts', e: b.public[1]!.exports[0] });
    expect(findExport(b, 'charge')?.file).toBe('src/payments/index.ts');
    expect(copyText(indexProject(project), { kind: 'export', bucket: 'payments', name: 'webhook' })).toBe('src/payments/server.ts:3');
  });

  it('lists each exported name once in the search', () => {
    expect(searchItems(project).filter((i) => i.kind === 'export').map((i) => i.label)).toEqual(['charge', 'webhook']);
  });
});
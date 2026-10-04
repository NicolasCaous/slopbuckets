// A large inspect snapshot built in memory, for tests of the layout decisions, the pages and the live diff: root with
// `small` (three children, one violation, one lock difference) and `wide` (n children in a contract chain).
import type { BucketSnapshot, ContractSnapshot, InspectSnapshot, ProjectSnapshot } from '../inspect/snapshot.js';

/** A bucket with the fields the layout decisions read. */
export function bucket(path: string, children: string[] = [], extra: Partial<BucketSnapshot> = {}): BucketSnapshot {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
  return {
    path,
    name,
    level: path.split('/').length - 1,
    parent,
    children: children.map((c) => `${path}/${c}`),
    files: 3,
    situation: 'ok',
    violations: 0,
    lockChanges: 0,
    offers: [],
    consumes: [],
    dependsOn: [],
    dependents: [],
    links: [],
    projects: [],
    rewriteCost: { symbols: 0, contracts: 0, dependents: 0 },
    ...extra,
  };
}

export function contract(owner: string, provider: string, consumer: string, extra: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    file: `${owner}/dmz/${provider}/${consumer}.ts`,
    owner,
    provider,
    consumer,
    providerBucket: provider.startsWith('.') ? owner : `${owner}/${provider}`,
    consumerBucket: consumer.startsWith('.') ? null : `${owner}/${consumer}`,
    situation: 'ok',
    lock: null,
    violations: 0,
    symbols: [{ name: `${provider}To${consumer}`, typeOnly: false, line: 1, from: '', origin: null, declaredIn: null, chain: [], signature: { hash: '', text: null }, used: true, importers: [], lock: null }],
    ...extra,
  };
}

/** root with `small` (3 children) and `wide` (`n` children named s0, s1...), each wide child consuming its neighbour. */
export function largeProject(n = 50): ProjectSnapshot {
  const names = Array.from({ length: n }, (_, i) => `s${i}`);
  const buckets: BucketSnapshot[] = [
    bucket('root', ['small', 'wide']),
    bucket('root/small', ['a', 'b', 'c']),
    bucket('root/small/a'),
    bucket('root/small/b', [], { situation: 'violation', violations: 2 }),
    bucket('root/small/c', [], { situation: 'lock', lockChanges: 1 }),
    bucket('root/wide', names),
    ...names.map((s) => bucket(`root/wide/${s}`)),
  ];
  const contracts = [
    contract('root/small', 'a', 'b'),
    contract('root/small', 'b', '.self', { situation: 'violation', violations: 1 }),
    ...names.slice(1).map((s, i) => contract('root/wide', names[i]!, s, i === 3 ? { situation: 'lock', lock: 'added' } : {})),
  ];
  return {
    path: '.',
    name: 'large',
    dir: '/large',
    parent: null,
    container: null,
    exitCode: 1,
    status: 'violation',
    config: { root: 'root', alias: '@root', maxDepth: 3, adapter: 'ts' },
    lock: 'differs',
    buckets,
    contracts,
    imports: [],
    cycles: [],
    orphans: [],
    violations: [
      { id: 'v1', rule: 'graph-cycle', file: 'root/small/b/_/x.ts', message: 'cycle', project: '.', bucket: 'root/small/b', kind: 'cycle', cycle: ['root/small/a', 'root/small/b', 'root/small/a'] },
      { id: 'v2', rule: 'import-forbidden', file: 'root/small/b/_/y.ts', message: 'forbidden', project: '.', bucket: 'root/small/b', kind: 'forbidden', target: { file: 'root/wide/s1/_/z.ts', bucket: 'root/wide/s1' } },
    ],
    lockChanges: [{ id: 'l1', kind: 'dmz-added', path: 'root/wide/dmz/s3/s4.ts', message: 'added', project: '.', bucket: 'root/wide' }],
    links: [],
    external: [],
    nested: [],
  };
}

export function largeSnapshot(n = 50): InspectSnapshot {
  const project = largeProject(n);
  return {
    snapshotVersion: 1,
    cli: '1.0.0',
    generatedAt: '2026-10-04T12:00:00.000Z',
    dir: '/large',
    exitCode: 1,
    summary: { projects: 1, buckets: project.buckets.length, contracts: project.contracts.length, symbols: project.contracts.length, violations: 2, lockChanges: 1, links: 0 },
    projects: [project],
    links: [],
  };
}


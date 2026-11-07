// The inspect snapshot of one project (contract/snapshot.ts), from the same graph and rule pass as the check.
// Each part comes from one pass over the bucket pairs that have imports or a declared dependency, not over all B * B
// pairs: 500 buckets make 250,000 pairs, and the B * B loops took 30 ms of the 70 ms the snapshot took at 50k files.
import type {
  Advice,
  EnvironmentError,
  FileGroup,
  FileOwner,
  PackageImport,
  SnapshotBucket,
  SnapshotEdge,
  SnapshotPackage,
  SnapshotProject,
  Violation,
} from '../contract/index.js';
import type { Config } from './config.js';
import { indexOf, type Graph } from './graph.js';
import { globTable, IGNORED, UNOWNED, type Owners } from './owners.js';
import type { CrossImport, RuleDetail } from './rules.js';

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function emptyProject(path: string, environment: EnvironmentError | null, violations: Violation[] = []): SnapshotProject {
  return { path, environment, ignore: [], projects: [], buckets: [], edges: [], files: [], violations, advice: [] };
}

export function buildSnapshot(path: string, g: Graph, config: Config, owners: Owners, detail: RuleDetail, violations: Violation[], advice: Advice[]): SnapshotProject {
  const B = config.buckets.length;
  const bucketId = new Map(config.buckets.map((b, i) => [b.name, i]));
  const table = globTable(config);
  const globs: { glob: string; count: number }[][] = Array.from({ length: B }, () => []);
  const ignore: { glob: string; count: number }[] = [];
  table.globs.forEach((glob, id) => {
    const b = table.bucket[id]!;
    if (b === -1) ignore.push({ glob, count: owners.hits[id]! });
    else globs[b]?.push({ glob, count: owners.hits[id]! });
  });
  const fileCount = new Int32Array(B);
  for (const o of owners.owner) if (o >= 0) fileCount[o]!++;

  const importsOf = (a: number, b: number) => detail.pairs.get(a * B + b) ?? [];
  // Bucket pairs a -> b with imports, and the pairs a config declares.
  const pairs = new Set<number>();
  const importers: number[][] = Array.from({ length: B }, () => []);
  for (const [pk, list] of detail.pairs) {
    const a = Math.floor(pk / B);
    const b = pk % B;
    if (a === b || list.length === 0) continue;
    pairs.add(pk);
    importers[b]!.push(a);
  }
  config.buckets.forEach((bucket, a) => {
    for (const dep in bucket.dependsOn) {
      const b = bucketId.get(dep);
      if (b !== undefined && b !== a) pairs.add(a * B + b);
    }
  });

  const buckets: SnapshotBucket[] = config.buckets.map((bucket, b) => {
    const namesBy = new Map<string, Set<string>>();
    for (const pub of bucket.public) {
      for (const [name, list] of detail.consumers.get(pub) ?? []) {
        for (const c of list) {
          let set = namesBy.get(c.bucket);
          if (set === undefined) namesBy.set(c.bucket, (set = new Set()));
          set.add(name);
        }
      }
    }
    const dependents = importers[b]!.map((a) => {
      const other = config.buckets[a]!.name;
      return { bucket: other, names: [...(namesBy.get(other) ?? [])].sort() };
    });
    dependents.sort((x, y) => cmp(x.bucket, y.bucket));
    const imported = detail.packages?.get(b) ?? new Map<string, PackageImport[]>();
    const packages: SnapshotPackage[] = [...new Set([...Object.keys(bucket.packages), ...imported.keys()])].map((name) => {
      const reason = bucket.packages[name] ?? null;
      const imports = [...(imported.get(name) ?? [])].sort((p, q) => cmp(p.file, q.file) || p.line - q.line);
      return { name, state: reason === null ? 'undeclared' : imports.length === 0 ? 'unused' : 'used', reason, imports };
    });
    packages.sort(byName);
    return {
      name: bucket.name,
      purpose: bucket.purpose,
      files: globs[b]!,
      fileCount: fileCount[b]!,
      public: bucket.public.map((file) => {
        const consumers = detail.consumers.get(file);
        return {
          file,
          exists: indexOf(g.files, file) >= 0,
          exports: (g.exports.get(file)?.names ?? []).map((x) => ({
            name: x.name,
            line: x.line,
            typeOnly: x.typeOnly,
            consumers: [...(consumers?.get(x.name) ?? [])].sort((p, q) => cmp(p.bucket, q.bucket) || cmp(p.file, q.file) || p.line - q.line),
          })),
        };
      }),
      external: bucket.external,
      packages,
      dependsOn: Object.entries(bucket.dependsOn)
        .map(([dep, reason]) => {
          const t = bucketId.get(dep);
          return { bucket: dep, reason, imports: t === undefined ? 0 : importsOf(b, t).length };
        })
        .sort((x, y) => cmp(x.bucket, y.bucket)),
      dependents,
    };
  });
  buckets.sort(byName);

  const edges: SnapshotEdge[] = [];
  for (const pk of pairs) {
    const from = config.buckets[Math.floor(pk / B)]!;
    const to = config.buckets[pk % B]!;
    const imports: CrossImport[] = importsOf(Math.floor(pk / B), pk % B);
    const reason = from.dependsOn[to.name];
    edges.push({
      from: from.name,
      to: to.name,
      state: reason === undefined ? 'undeclared' : imports.length === 0 ? 'unused' : 'used',
      reason: reason ?? null,
      imports: imports.map((i) => ({ ...i })).sort((p, q) => cmp(p.file, q.file) || p.line - q.line),
    });
  }
  edges.sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to));

  return {
    path,
    environment: null,
    ignore,
    projects: config.projects.map((p) => p.written),
    buckets,
    edges,
    files: fileGroups(g, config, owners),
    violations,
    advice,
  };
}

// The groups of the last snapshots, by owners. The owners object stays the same while the file list and the config
// do (computeOwners), so a live update after a content change skips the 13 ms pass over 50k files.
const groupsOf = new WeakMap<Owners, { files: readonly string[]; groups: FileGroup[] }>();

/** Files grouped by folder and owner, sorted by folder and then by the owner as JSON. */
function fileGroups(g: Graph, config: Config, owners: Owners): FileGroup[] {
  const known = groupsOf.get(owners);
  if (known !== undefined && known.files === g.files) return known.groups;
  // The owner JSON is built once per owner, not per file.
  const ownerOf = new Map<number, { owner: FileOwner; json: string }>();
  const describe = (owner: FileOwner) => ({ owner, json: JSON.stringify(owner) });
  const groups = new Map<string, FileGroup>();
  g.files.forEach((file, i) => {
    const o = owners.owner[i]!;
    let known = ownerOf.get(o);
    if (known === undefined) {
      if (o >= 0) known = describe({ state: 'bucket', bucket: config.buckets[o]!.name });
      else if (o === IGNORED) known = describe({ state: 'ignored' });
      else if (o === UNOWNED) known = describe({ state: 'unowned' });
      else known = describe({ state: 'overlap', buckets: (owners.overlaps.get(file) ?? []).map((x) => x.bucket).sort() });
      if (o >= 0 || o === IGNORED || o === UNOWNED) ownerOf.set(o, known);
    }
    const slash = file.lastIndexOf('/');
    const dir = slash < 0 ? '' : file.slice(0, slash);
    const key = `${dir}\0${known.json}`;
    let group = groups.get(key);
    if (group === undefined) groups.set(key, (group = { dir, owner: known.owner, names: [] }));
    group.names.push(file.slice(slash + 1));
  });
  const files = [...groups.entries()].sort(([a], [b]) => cmp(a, b)).map(([, group]) => group);
  groupsOf.set(owners, { files: g.files, groups: files });
  return files;
}

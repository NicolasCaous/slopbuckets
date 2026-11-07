// The inspect snapshot, version 2: what `buckets inspect --json` prints and what the inspect page loads.
// Paths are relative to their project with `/`. Lists are sorted (buckets and edges by name, folders by path) so
// the same project gives byte-identical JSON.
import type { EnvironmentError } from './engine.js';
import type { Advice, PackageImport, Violation } from './violation.js';

export interface SnapshotV2 {
  snapshotVersion: 2;
  /** The root project `.` first, then nested projects in tree order. */
  projects: SnapshotProject[];
}

export interface SnapshotProject {
  /** `.` or the folder relative to the session root, such as 'packages/sdk'. */
  path: string;
  /** Null when the project could not be checked; buckets, edges, files and violations are then empty. */
  environment: EnvironmentError | null;
  ignore: GlobCount[];
  /** Nested project folders as listed in the config. */
  projects: string[];
  buckets: SnapshotBucket[];
  edges: SnapshotEdge[];
  files: FileGroup[];
  /** Sorted with sortViolations. Group them by bucket with violationBuckets. */
  violations: Violation[];
  /** Sorted with sortAdvice. Never counted as violations. */
  advice: Advice[];
}

/** A glob with the number of files it matches, or excludes when it starts with `!`. */
export interface GlobCount {
  glob: string;
  count: number;
}

export interface SnapshotBucket {
  name: string;
  purpose: string;
  files: GlobCount[];
  /** Files the bucket owns alone, overlaps left out. */
  fileCount: number;
  /** One entry per listed public file, in the order of the config. [] for a closed bucket. */
  public: SnapshotPublic[];
  external: string | null;
  dependsOn: { bucket: string; reason: string; imports: number }[];
  /** Declared and imported external modules, sorted by name. */
  packages: SnapshotPackage[];
  /** Buckets that import this one, declared or not, with the exported names each one uses. */
  dependents: { bucket: string; names: string[] }[];
}

export interface SnapshotPublic {
  file: string;
  /** False when the file does not exist (public-missing). */
  exists: boolean;
  exports: SnapshotExport[];
}

export interface SnapshotExport {
  name: string;
  line: number;
  typeOnly: boolean;
  /** Imports of this name from other buckets. Empty means export-unused, unless the bucket is external. */
  consumers: { bucket: string; file: string; line: number }[];
}

/**
 * A packages key of the bucket. used: declared and imported. unused: declared, never imported. undeclared: imported,
 * not declared. `reason` is null for undeclared; `imports` lists every import statement of it, sorted by file and line.
 */
export interface SnapshotPackage {
  name: string;
  state: 'used' | 'unused' | 'undeclared';
  reason: string | null;
  imports: PackageImport[];
}

/**
 * used: declared and imported. unused: declared, never imported. undeclared: imported, not declared.
 * `reason` is null for undeclared.
 */
export interface SnapshotEdge {
  from: string;
  to: string;
  state: 'used' | 'unused' | 'undeclared';
  reason: string | null;
  imports: SnapshotImport[];
}

export interface SnapshotImport {
  file: string;
  line: number;
  target: string;
  names: string[] | '*';
  /** The target is not a public file of the imported bucket. */
  private: boolean;
}

export type FileOwner =
  | { state: 'bucket'; bucket: string }
  | { state: 'ignored' }
  | { state: 'unowned' }
  /** Two or more buckets. A file that ignore matches is `ignored`, whatever buckets match it too. */
  | { state: 'overlap'; buckets: string[] };

/** Files of one folder that share an owner. 50,000 files fit in about 1 MB this way. */
export interface FileGroup {
  /** Folder relative to the project, '' for the project root. */
  dir: string;
  owner: FileOwner;
  /** File names inside `dir`, sorted. */
  names: string[];
}

/** Lists every file of a project with its owner. */
export function* snapshotFiles(project: SnapshotProject): Generator<{ path: string; owner: FileOwner }> {
  for (const group of project.files) {
    for (const name of group.names) yield { path: group.dir === '' ? name : `${group.dir}/${name}`, owner: group.owner };
  }
}

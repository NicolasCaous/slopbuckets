// The Violation union: one variant per rule, each with the data its message needs (messages.ts), and the Advice
// union, the notes that never fail a check. Every path is relative to the project folder and uses `/`. `project` is
// the project folder relative to the session root, `.` for the root project.
import { CONFIG_FILE, type AdviceId, type RuleId } from './rules.js';

interface Base {
  project: string;
}

/** A name an import statement takes from its target. `typeOnly` for `import type { A }`, `import { type A }` and `export type { A } from`. */
export interface ImportName {
  name: string;
  typeOnly: boolean;
  /**
   * Set on a private import when the target exports the name as a type only (an interface, a type alias or
   * `export type`), so a public file must re-export it with `export type { }` under isolatedModules.
   */
  isType?: true;
}

/** True when a re-export of the name needs `export type`: the import takes it as a type, or the target declares a type. */
export const asType = (n: ImportName): boolean => n.typeOnly || n.isType === true;

/** One import statement: the importing file, its 1-based line, the imported file and the names it takes. */
export interface ImportRef {
  file: string;
  line: number;
  target: string;
  /** The names in source order, `default` included. [] for a side-effect import and for import * (import-namespace reports that). */
  names: ImportName[];
}

/** A name that a public file already re-exports from `target` under the same name, so importers can take it from there. */
export interface Reexported {
  target: string;
  name: string;
}

/** An import between two buckets. `private` when `target` is not a public file of the imported bucket. */
export interface BucketImport extends ImportRef {
  private: boolean;
}

/** An import of an npm package or a Node built-in, with the specifier as written, such as 'lodash/merge'. */
export interface PackageImport {
  file: string;
  line: number;
  specifier: string;
}

/** Another bucket's declared dependency or package, with its reason, shown as an example in a message. */
export interface DeclaredBy {
  bucket: string;
  reason: string;
}

/** A path inside buckets.config.json, such as ['buckets', 'billing', 'dependsOn', 'log'] or ['ignore', 0]. [] is the top level. */
export type ConfigPath = (string | number)[];

/** What makes the config invalid. messages.ts turns each kind into an error line and a `fix config:` line. */
export type ConfigProblem =
  /** The file is not valid JSON. `message` is the parser error. */
  | { kind: 'json'; message: string }
  /** The value at `at` has the wrong type or shape. `expected` completes "must be ...", such as "an array of strings". */
  | { kind: 'invalid'; at: ConfigPath; expected: string }
  /** The object at `at` lacks the required field `field`. */
  | { kind: 'missing'; at: ConfigPath; field: string }
  /** The object at `at` has a field the schema does not know. */
  | { kind: 'unknown-field'; at: ConfigPath; field: string }
  /** The string, array or object at `at` is empty: a purpose, reason, external, glob, path, the files list or the public list. */
  | { kind: 'empty'; at: ConfigPath }
  /** The one-line string at `at` (purpose, reason, external) has a line break. */
  | { kind: 'multiline'; at: ConfigPath }
  /** A key of `buckets` is not a valid bucket name. */
  | { kind: 'bucket-name'; name: string }
  /** buckets.<bucket>.dependsOn names a bucket that does not exist. */
  | { kind: 'unknown-bucket'; bucket: string; dependency: string }
  /**
   * An edit removes the bucket key `from`, which the dependsOn of `referencedBy` (sorted) still name, and adds the key
   * `to` (the first added key in file order when it adds several). It replaces the unknown-bucket problems that name
   * `from`. Only an edit gives it: checkEdit compares the config on disk with the edited text.
   */
  | { kind: 'bucket-renamed'; from: string; to: string; referencedBy: string[] }
  /** A key of buckets.<bucket>.packages is not a package key (packageKey(name) !== name). `key` is packageKey(name). */
  | { kind: 'package-name'; bucket: string; name: string; key: string };

/** One violation per problem. A config with several problems gives several violations. */
export interface ConfigInvalidViolation extends Base {
  rule: 'config-invalid';
  problem: ConfigProblem;
}

/** One dependsOn entry of a cycle: its reason, and one import that backs it, or null when no file of `from` imports `to`. */
export interface CycleEdge {
  from: string;
  to: string;
  reason: string;
  import: ImportRef | null;
}

export interface ConfigCycleViolation extends Base {
  rule: 'config-cycle';
  /** Bucket names along the cycle, each depending on the next and the last on the first. The first is not repeated. */
  cycle: string[];
  /** One edge per name of `cycle`: cycle[i] -> cycle[i + 1], and the last back to the first. */
  edges: CycleEdge[];
}

/**
 * One violation per pair of buckets, with every import that forms the dependency. The private imports of the pair
 * belong here too, flagged `private`, and no import-private is reported for an undeclared pair: one block offers the
 * fixes of both (declare the dependency and import from a public file, or move the code).
 */
export interface DependencyUndeclaredViolation extends Base {
  rule: 'dependency-undeclared';
  from: string;
  to: string;
  fromPurpose: string;
  toPurpose: string;
  /** Non-empty, sorted by file and line. */
  imports: BucketImport[];
  /** The public files of `to`, [] when `to` is closed. */
  public: string[];
  /** The names of the private imports that a public file of `to` already re-exports, sorted. Absent when none. */
  reexported?: Reexported[];
  /** Up to DEPENDENTS_SHOWN buckets that already declare `to` in dependsOn, with their reasons, sorted by name. */
  dependents: DeclaredBy[];
  /**
   * Null, or the dependsOn path from `to` back to `from` that already exists, both ends included, such as
   * ['log', 'billing']. Declaring the dependency would close a cycle, so the message offers no config fix.
   */
  reversePath: string[] | null;
  /** Set when `to` also imports `from` without a dependsOn entry, so declaring both directions would make a cycle. */
  reverseUndeclared?: true;
}

export interface DependencyUnusedViolation extends Base {
  rule: 'dependency-unused';
  from: string;
  to: string;
  reason: string;
}

/**
 * One violation per pair of buckets where `from` declares `to` in dependsOn and imports files of `to` that are not
 * public. An undeclared pair reports its private imports in dependency-undeclared instead. The names these imports
 * take count as used for export-unused.
 */
export interface ImportPrivateViolation extends Base {
  rule: 'import-private';
  from: string;
  to: string;
  /** Every private import of the pair, non-empty, sorted by file and line. */
  imports: ImportRef[];
  /** The public files of `to`, [] when `to` is closed. */
  public: string[];
  /** The names of `imports` that a public file of `to` already re-exports, sorted. Absent when none. */
  reexported?: Reexported[];
}

/**
 * A specifier that should name a file of the project and does not resolve: `relative` ('./x', '../x'), `paths` (it
 * matches the tsconfig paths pattern `pattern`, or without a pattern it names a folder under baseUrl), or `workspace`
 * (a package whose real path is inside the project).
 * Only files of a bucket are checked. While a bucket has one, the engine holds back the dependency-unused and
 * export-unused violations that the unresolved import could explain.
 */
export interface ImportUnresolvedViolation extends Base {
  rule: 'import-unresolved';
  /** The bucket of `file`. */
  bucket: string;
  file: string;
  line: number;
  specifier: string;
  kind: 'relative' | 'paths' | 'workspace';
  /** The tsconfig paths pattern, such as '@/*', for `paths`; null for a path under the tsconfig baseUrl, and for the other kinds. */
  pattern: string | null;
}

export interface ImportIgnoredViolation extends Base {
  rule: 'import-ignored';
  file: string;
  line: number;
  /** The ignored file. */
  target: string;
}

export interface ImportDynamicViolation extends Base {
  rule: 'import-dynamic';
  file: string;
  line: number;
  call: 'import' | 'require';
}

export interface ImportNamespaceViolation extends Base {
  rule: 'import-namespace';
  file: string;
  line: number;
  from: string;
  to: string;
  /** import * as x, export * from, import() without destructuring, require() without destructuring. */
  form: 'import' | 'export' | 'dynamic' | 'require';
  /** The module specifier as written, such as '../payments'. */
  specifier: string;
}

/** A folder glob such as 'src/billing/**' with the number of unowned files under it. */
export interface FolderCount {
  folder: string;
  count: number;
}

/**
 * One file, a folder whose every file is unowned, or, when the config has no buckets yet, one violation for the whole
 * project: `count` unowned files, the folders at the first level where sibling folders exist with their file counts,
 * and the unowned files above that level. groupUnowned builds all three.
 */
export type FileUnownedViolation = Base & { rule: 'file-unowned' } & (
    | { file: string }
    | FolderCount
    | { noBuckets: true; count: number; folders: FolderCount[]; files: string[] }
  );

/** A bucket with the glob of it that matches the file. */
export interface OverlapOwner {
  bucket: string;
  glob: string;
}

export interface FileOverlapViolation extends Base {
  rule: 'file-overlap';
  file: string;
  /**
   * Two or more buckets. Ignore is never an owner here: the engine removes ignored files before it matches bucket globs.
   * The fix suggests excluding the other globs from the first owner, so the engine puts the broader glob first (fewer
   * literal path segments), then sorts by name.
   */
  owners: OverlapOwner[];
}

export interface GlobEmptyViolation extends Base {
  rule: 'glob-empty';
  field: 'files' | 'ignore' | 'projects';
  /** The bucket for `files`, null otherwise. */
  bucket: string | null;
  /** The glob as written, `!` included, or the folder for `projects`. */
  glob: string;
}

/** One violation per listed public file that does not exist or is not the bucket's. */
export interface PublicMissingViolation extends Base {
  rule: 'public-missing';
  bucket: string;
  /** The listed file. */
  public: string;
  /** not-found: no such file. other-bucket: `owner` owns it. ignored: only ignore matches it. unowned: nothing matches it. */
  state: 'not-found' | 'other-bucket' | 'ignored' | 'unowned';
  /** The owning bucket for `other-bucket`, null otherwise. */
  owner: string | null;
}

/** Violations of one public file; a bucket with several public files gets them per file. */
export type PublicNotInterfaceViolation = Base & {
  rule: 'public-not-interface';
  bucket: string;
  public: string;
  line: number;
} & (
    /** One per public file, at the first line that holds anything other than named re-exports. */
    | { kind: 'code' }
    /** One per `export * from` statement. */
    | { kind: 'export-star'; specifier: string }
    /** One per re-export whose source belongs to another bucket. */
    | { kind: 'foreign-reexport'; source: string; sourceBucket: string }
  );

export interface ProjectUndeclaredViolation extends Base {
  rule: 'project-undeclared';
  /** Folder of the nested buckets.config.json, such as 'packages/sdk'. */
  folder: string;
}

/** One violation per public file and name. A name another bucket imports through a private path counts as used. */
export interface ExportUnusedViolation extends Base {
  rule: 'export-unused';
  bucket: string;
  /** The exported name, `default` included. */
  name: string;
  public: string;
  line: number;
}

/** One violation per bucket and package key, with every import of it. Type-only imports count. */
export interface PackageUndeclaredViolation extends Base {
  rule: 'package-undeclared';
  bucket: string;
  purpose: string;
  /** The packages key, such as 'lodash' or 'node:fs'. */
  package: string;
  /** Non-empty, sorted by file and line. */
  imports: PackageImport[];
  /** Up to DEPENDENTS_SHOWN other buckets that declare the package, with their reasons, sorted by name. */
  declaredBy: DeclaredBy[];
}

export interface PackageUnusedViolation extends Base {
  rule: 'package-unused';
  bucket: string;
  package: string;
  reason: string;
}

export type Violation =
  | ConfigInvalidViolation
  | ConfigCycleViolation
  | DependencyUndeclaredViolation
  | DependencyUnusedViolation
  | ImportPrivateViolation
  | ImportUnresolvedViolation
  | ImportIgnoredViolation
  | ImportDynamicViolation
  | ImportNamespaceViolation
  | FileUnownedViolation
  | FileOverlapViolation
  | GlobEmptyViolation
  | PublicMissingViolation
  | PublicNotInterfaceViolation
  | ProjectUndeclaredViolation
  | ExportUnusedViolation
  | PackageUndeclaredViolation
  | PackageUnusedViolation;

export type ViolationOf<R extends RuleId> = Extract<Violation, { rule: R }>;

/**
 * Advice: a note about the config that never fails a check (rules.ts, ADVICE_IDS). `at` is the config path the
 * note is about. `buckets check --json` lists them in CheckResult.advice, apart from the violations.
 */
export type Advice =
  /**
   * A purpose, a dependsOn or packages reason, or an external line that reasonAdvice() flags: `short` (fewer than
   * REASON_MIN_WORDS words) or `generic` (only bucket names and a generic verb). `text` is the value as written.
   */
  | { advice: 'reason-generic'; project: string; at: ConfigPath; text: string; why: 'short' | 'generic' }
  /** ignore[i] matches `count` of the `total` source files of the project, more than IGNORE_LARGE_SHARE of them. */
  | { advice: 'ignore-large'; project: string; at: ConfigPath; glob: string; count: number; total: number };

export type AdviceOf<A extends AdviceId> = Extract<Advice, { advice: A }>;

function configProblemId(p: ConfigProblem): unknown[] {
  switch (p.kind) {
    case 'json':
      return [p.kind];
    case 'bucket-name':
      return [p.kind, p.name];
    case 'unknown-bucket':
      return [p.kind, p.bucket, p.dependency];
    case 'bucket-renamed':
      return [p.kind, p.from, p.to];
    case 'package-name':
      return [p.kind, p.bucket, p.name];
    case 'missing':
    case 'unknown-field':
      return [p.kind, p.at, p.field];
    default:
      return [p.kind, p.at];
  }
}

/**
 * A stable id: the same problem gives the same key in every run, so the session remembers what it already showed.
 * Keys leave out line numbers where a file and target identify the problem, so an edit above an import does not make
 * it look new. Grouped violations (dependency-undeclared, import-private, package-undeclared) are keyed by their
 * group, so a new import in the same group does not show the block again. import-dynamic, import-namespace,
 * public-not-interface code and export-star keep the line.
 */
export function violationKey(v: Violation): string {
  const id = ((): unknown[] => {
    switch (v.rule) {
      case 'config-invalid':
        return configProblemId(v.problem);
      case 'config-cycle': {
        const start = v.cycle.indexOf([...v.cycle].sort()[0]!);
        return [...v.cycle.slice(start), ...v.cycle.slice(0, start)];
      }
      case 'dependency-undeclared':
      case 'dependency-unused':
      case 'import-private':
        return [v.from, v.to];
      case 'import-unresolved':
        return [v.file, v.specifier];
      case 'import-ignored':
        return [v.file, v.target];
      case 'import-dynamic':
        return [v.file, v.line];
      case 'import-namespace':
        return [v.file, v.line, v.specifier];
      case 'file-unowned':
        return 'noBuckets' in v ? ['no-buckets'] : 'folder' in v ? [v.folder] : [v.file];
      case 'file-overlap':
        return [v.file];
      case 'glob-empty':
        return [v.field, v.bucket, v.glob];
      case 'public-missing':
        return [v.bucket, v.public];
      case 'public-not-interface':
        if (v.kind === 'code') return [v.bucket, v.public, v.kind];
        if (v.kind === 'export-star') return [v.bucket, v.public, v.kind, v.line, v.specifier];
        return [v.bucket, v.public, v.kind, v.source];
      case 'project-undeclared':
        return [v.folder];
      case 'export-unused':
        return [v.bucket, v.public, v.name];
      case 'package-undeclared':
      case 'package-unused':
        return [v.bucket, v.package];
    }
  })();
  return JSON.stringify([v.rule, v.project, ...id]);
}

/**
 * The file a violation points at, relative to its project, and the line when there is one. Config rules point at
 * buckets.config.json. The examples battery matches `expect.violations[].file` and `.line` against this.
 */
export function violationLocation(v: Violation): { file: string; line?: number } {
  switch (v.rule) {
    case 'config-invalid':
    case 'config-cycle':
    case 'dependency-unused':
    case 'glob-empty':
    case 'package-unused':
      return { file: CONFIG_FILE };
    case 'dependency-undeclared':
    case 'import-private':
    case 'package-undeclared':
      return { file: v.imports[0]!.file, line: v.imports[0]!.line };
    case 'import-unresolved':
    case 'import-ignored':
    case 'import-dynamic':
    case 'import-namespace':
      return { file: v.file, line: v.line };
    case 'file-unowned':
      return { file: 'noBuckets' in v ? CONFIG_FILE : 'folder' in v ? v.folder : v.file };
    case 'file-overlap':
      return { file: v.file };
    case 'public-missing':
      return { file: v.public };
    case 'public-not-interface':
    case 'export-unused':
      return { file: v.public, line: v.line };
    case 'project-undeclared':
      return { file: `${v.folder}/${CONFIG_FILE}` };
  }
}

/** The buckets a violation concerns, for grouping by bucket. Empty for file-unowned, glob-empty outside files, and project-undeclared. */
export function violationBuckets(v: Violation): string[] {
  switch (v.rule) {
    case 'config-invalid':
      if (v.problem.kind === 'bucket-name') return [v.problem.name];
      if (v.problem.kind === 'unknown-bucket' || v.problem.kind === 'package-name') return [v.problem.bucket];
      if (v.problem.kind === 'bucket-renamed') return [v.problem.to, ...v.problem.referencedBy];
      if (v.problem.kind !== 'json' && v.problem.at[0] === 'buckets' && typeof v.problem.at[1] === 'string') return [v.problem.at[1]];
      return [];
    case 'config-cycle':
      return [...v.cycle];
    case 'dependency-undeclared':
    case 'dependency-unused':
    case 'import-private':
    case 'import-namespace':
      return [v.from, v.to];
    case 'file-overlap':
      return v.owners.map((o) => o.bucket);
    case 'glob-empty':
      return v.bucket === null ? [] : [v.bucket];
    case 'public-missing':
    case 'export-unused':
    case 'import-unresolved':
    case 'package-undeclared':
    case 'package-unused':
      return [v.bucket];
    case 'public-not-interface':
      return v.kind === 'foreign-reexport' ? [v.bucket, v.sourceBucket] : [v.bucket];
    case 'import-ignored':
    case 'import-dynamic':
    case 'file-unowned':
    case 'project-undeclared':
      return [];
  }
}

/** Sorts by project, file, line, rule, then key: the order every output uses. Returns a new array. */
export function sortViolations(list: readonly Violation[]): Violation[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return list
    .map((v) => ({ v, loc: violationLocation(v), key: violationKey(v) }))
    .sort(
      (a, b) =>
        cmp(a.v.project, b.v.project) ||
        cmp(a.loc.file, b.loc.file) ||
        (a.loc.line ?? 0) - (b.loc.line ?? 0) ||
        cmp(a.v.rule, b.v.rule) ||
        cmp(a.key, b.key),
    )
    .map((x) => x.v);
}

/** Sorts advice by project, then config path. Returns a new array. */
export function sortAdvice(list: readonly Advice[]): Advice[] {
  // Each key once: a config of 500 buckets can give thousands of advice.
  return list
    .map((a) => ({ a, key: JSON.stringify([a.project, a.at]) }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .map((x) => x.a);
}

/** A folder groups when it holds at least this many files and every one of them is unowned. */
export const UNOWNED_GROUP_MIN = 5;

/**
 * Builds the file-unowned violations of one project. `unowned` lists the unowned files; `all` lists every considered
 * file of the project, owned and ignored included. A folder becomes one `src/legacy/**` violation when all its files
 * are unowned and there are at least `min` of them; the topmost such folder wins. A folder with subfolders never
 * groups when it is directly under the project root, or when its parent does not group either and it is the parent's
 * only subfolder, or when it holds more than half of `all`: its subfolders group instead, at the first level where
 * sibling folders exist and none holds more than half, so a group never covers most of the project. Files at the
 * project root never group, nor do the files directly in a folder that does not group. Output is sorted by path.
 *
 * `noBuckets` is for a config whose `buckets` is empty: the result is one violation that lists the folders that
 * group with `min` 1 and the files that do not, or [] when nothing is unowned.
 */
export function groupUnowned(
  project: string,
  unowned: readonly string[],
  all: readonly string[],
  min = UNOWNED_GROUP_MIN,
  noBuckets = false,
): FileUnownedViolation[] {
  if (noBuckets) {
    if (unowned.length === 0) return [];
    const parts = groupUnowned(project, unowned, unowned, 1);
    const folders = parts.flatMap((v) => ('folder' in v ? [{ folder: v.folder, count: v.count }] : []));
    const files = parts.flatMap((v) => ('file' in v ? [v.file] : []));
    return [{ rule: 'file-unowned', project, noBuckets: true, count: unowned.length, folders, files }];
  }
  const ancestors = (file: string): string[] => {
    const parts = file.split('/');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
  };
  const total = new Map<string, number>();
  const subfolders = new Map<string, Set<string>>();
  for (const file of all) {
    const dirs = ancestors(file);
    for (const dir of dirs) total.set(dir, (total.get(dir) ?? 0) + 1);
    for (let i = 1; i < dirs.length; i++) {
      const set = subfolders.get(dirs[i - 1]!) ?? new Set<string>();
      subfolders.set(dirs[i - 1]!, set.add(dirs[i]!));
    }
  }
  const skipped = (dir: string): boolean => {
    if (!subfolders.has(dir)) return false;
    if (total.get(dir)! * 2 > all.length) return true;
    const slash = dir.lastIndexOf('/');
    if (slash < 0) return true;
    const parent = dir.slice(0, slash);
    return subfolders.get(parent)!.size === 1 && skipped(parent);
  };
  const bad = new Map<string, number>();
  for (const file of unowned) for (const dir of ancestors(file)) bad.set(dir, (bad.get(dir) ?? 0) + 1);
  const out = new Map<string, FileUnownedViolation>();
  for (const file of unowned) {
    const dir = ancestors(file).find((d) => bad.get(d) === total.get(d) && !skipped(d));
    if (dir !== undefined && bad.get(dir)! >= min) {
      const glob = `${dir}/**`;
      out.set(glob, { rule: 'file-unowned', project, folder: glob, count: bad.get(dir)! });
    } else {
      out.set(file, { rule: 'file-unowned', project, file });
    }
  }
  return [...out.keys()].sort().map((k) => out.get(k)!);
}

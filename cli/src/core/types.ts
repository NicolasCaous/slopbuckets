// Shared types of the CLI core. CheckReport, RuleId, LockChangeKind and EnvironmentCode are part of the
// public contract described in SPEC.md ("Implementação"), so their values must not change.
import type { AnalyzeRequest, AnalyzeResponse, InfoResponse, InitRequest, InitResponse } from '@slopbuckets/adapter-ts';

export type RuleId =
  | 'config-invalid'
  | 'project-config'
  | 'folder-loose-file'
  | 'folder-max-depth'
  | 'folder-missing-code'
  | 'folder-unexpected-dmz'
  | 'folder-invalid-name'
  | 'folder-symlink'
  | 'dmz-path'
  | 'dmz-syntax'
  | 'dmz-target'
  | 'dmz-orphan'
  | 'import-relative'
  | 'import-dynamic'
  | 'import-unresolved'
  | 'import-forbidden'
  | 'import-namespace-dmz'
  | 'import-undeclared-package'
  | 'import-global'
  | 'graph-cycle'
  | 'access-denied'
  | 'access-ambiguous'
  | 'access-unknown-bucket'
  | 'project-misplaced'
  | 'link-missing'
  | 'link-forbidden-import'
  | 'link-missing-dependency';

export type LockChangeKind =
  | 'lock-missing'
  | 'bucket-added'
  | 'bucket-removed'
  | 'config-changed'
  | 'dmz-added'
  | 'dmz-removed'
  | 'dmz-changed'
  | 'symbol-added'
  | 'symbol-removed'
  | 'signature-changed'
  | 'project-added'
  | 'project-removed'
  | 'link-added'
  | 'link-removed'
  | 'link-changed'
  | 'link-drift';

export type EnvironmentCode = 'no-config' | 'cli-version' | 'adapter-version' | 'no-typescript' | 'no-tsconfig' | 'adapter-failed';

export interface Violation {
  rule: RuleId;
  /** Relative to the project named by `project`. */
  file: string;
  line?: number;
  message: string;
  /**
   * The project of the violation, relative to the project where the check ran, `.` for that project itself.
   * The CLI sets it on every violation, also when only one project is checked.
   */
  project?: string;
}

export interface LockChange {
  kind: LockChangeKind;
  /** Relative to the project named by `project`. */
  path: string;
  symbol?: string;
  message: string;
  /** Like `Violation.project`. */
  project?: string;
}

export type ExitCode = 0 | 1 | 2 | 3;

export interface CheckReport {
  exitCode: ExitCode;
  violations: Violation[];
  lockChanges: LockChange[];
  environment?: { code: EnvironmentCode; message: string };
  /**
   * Every project the check ran on, the current one first as `.`, then the nested ones in tree order, each with
   * its own exit code. The recursive check always sets it.
   */
  projects?: { path: string; exitCode: ExitCode }[];
  /**
   * Only from `buckets check --json`, and only when the npm registry has a newer slopbuckets than the installed one:
   * both versions and the notice the CLI also prints on stderr. It never changes the exit code.
   */
  update?: { installed: string; latest: string; message: string };
}

/**
 * A registered link: `<bucket>/_/links/<name>/` holds the source of another project's root folder, as a junction
 * (or folder symlink) to it or as a copy of the files its `.external.ts` files reach.
 */
export interface LockLink {
  name: string;
  /** The folder of the origin project, relative to this project with `/` when possible (it can start with `../`), absolute otherwise. */
  origin: string;
  /** `link`: a junction or folder symlink, kept out of git. `copy`: a committed copy. */
  mode: 'link' | 'copy';
  /** The import alias of the origin project. Locks of version 2 do not have it. */
  alias?: string;
  /**
   * The symbols the origin publishes, by `.external.ts` file (relative to the link folder) and then by name, with
   * their signature hashes. Absent in a computed lock when the link is missing on disk, and in locks of version 2.
   */
  symbols?: Record<string, Record<string, string>>;
  /** Locks of version 2 only: the hash of the generated declarations. Ignored. */
  hash?: string;
}

export interface Lock {
  /** 1 for locks written before nested projects and links, 2 for links of generated declarations, 3 for source links. */
  lockVersion: 1 | 2 | 3;
  cli: string;
  /**
   * `toolchain` names the tools whose version can change signature hashes, such as "typescript@5.9.3".
   * Locks written before the adapter reported it do not have it.
   */
  adapter: { name: string; version: string; toolchain?: string };
  config: string;
  buckets: string[];
  /** `external` exists only in locks of version 2 (the hash of a generated `.external/` folder). It is ignored. */
  dmz: Record<string, { text: string; symbols: Record<string, string>; external?: string }>;
  /** Nested projects, relative to this project. Missing means none. */
  projects?: string[];
  /** Registered links by link folder (`<bucket>/_/links/<name>`). Missing means none. */
  links?: Record<string, LockLink>;
}

/**
 * Protocol additions for links, as SPEC.md defines them ("Links de código-fonte"). Declared here so the CLI does not
 * depend on the adapter's own declaration of them.
 */
export interface AnalyzeLinkRequest {
  /** The link folder, relative to the project. */
  path: string;
  /** The import alias of the origin project. */
  alias: string;
}

export interface LinkAnalysis {
  /** Every symbol the origin's `.external.ts` files publish. `file` is relative to the project, through the link. */
  exports: { file: string; name: string; typeOnly: boolean; signature: string; line: number }[];
  /**
   * Every package a linked file imports. `resolved` is true when it resolves for type checking (from the link path,
   * in this project) and at runtime (from the real path: the origin for a junction, this project for a copy).
   * `resolvedForTypes` and `resolvedAtRuntime` tell the two apart; an older adapter leaves them out.
   */
  dependencies: { package: string; from: string; resolved: boolean; resolvedForTypes?: boolean; resolvedAtRuntime?: boolean }[];
  problems: { file?: string; line?: number; message: string }[];
}

export type LinkedAnalyzeRequest = AnalyzeRequest & { links?: AnalyzeLinkRequest[] };
export type LinkedAnalyzeResponse = AnalyzeResponse & { links?: Record<string, LinkAnalysis> };

/** The operations the CLI needs from a language adapter. The real one is `@slopbuckets/adapter-ts`; tests inject fakes. */
export interface Adapter {
  info(): InfoResponse;
  init(projectDir: string, request: InitRequest): Promise<InitResponse>;
  analyze(projectDir: string, request: LinkedAnalyzeRequest): Promise<LinkedAnalyzeResponse>;
}

/** Everything the core needs from the outside world besides the file system. */
export interface Context {
  adapter: Adapter;
  cliVersion: string;
}

/** Raised for problems that stop the check with exit code 3. */
export class EnvironmentError extends Error {
  constructor(
    readonly code: EnvironmentCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

// The rule engine interface that the hooks, `buckets check` and inspect call.
import { EXIT_CODES, type EnvironmentCode, type ExitCode } from './rules.js';
import type { SnapshotV2 } from './snapshot.js';
import type { Advice, Violation } from './violation.js';

/** A project that could not be checked at all. */
export interface EnvironmentError {
  code: EnvironmentCode;
  /** The project folder relative to the session root, `.` for the root project. */
  project: string;
  /** One sentence that says what is wrong and what to do. */
  message: string;
}

export interface CheckResult {
  /** 3 when any environment error exists, else 1 when any violation exists, else 0. */
  exitCode: ExitCode;
  /** Sorted with sortViolations. */
  violations: Violation[];
  environment: EnvironmentError[];
  /** Sorted with sortAdvice. Never counted for exitCode, never in the pending list, never a reason to block a stop. */
  advice: Advice[];
  /** Every project that was checked or tried: `.` first, then nested projects in tree order. */
  projects: string[];
}

/**
 * One file change. `path` is absolute, or relative to the session root, with either separator. `content` is the
 * whole new text of the file, or null when the file is deleted. A rename is a delete plus a create.
 */
export interface FileEdit {
  path: string;
  content: string | null;
}

export interface RuleEngine {
  /**
   * Checks the project at `root` and every nested project it lists in `projects`, recursively. `recursive: false`
   * checks only the project at `root`.
   */
  checkAll(root: string, options?: { recursive?: boolean }): Promise<CheckResult>;
  /**
   * The full result as it would be after the edits, without writing anything to disk. One call takes every file an
   * apply_patch touches. A result with config-invalid means the hook must deny the edit.
   */
  checkEdit(root: string, edit: FileEdit | readonly FileEdit[]): Promise<CheckResult>;
  /**
   * Re-verifies a known list against the files on disk, reading only the files and config the violations name, and
   * returns the ones still present (same key), in the given order. It never finds new violations.
   */
  recheck(root: string, previous: readonly Violation[]): Promise<Violation[]>;
  /**
   * The inspect snapshot of the project at `root` and its nested projects, built from the same graph as checkAll.
   * `changed` lists the paths (absolute, or relative to root, with either separator) that the caller knows were
   * added, modified or deleted since the last snapshot. The engine may then skip listing every file and read only
   * those paths, which only works when nothing else changed: a caller that is not sure leaves `changed` out. The
   * result is the same either way.
   */
  snapshot(root: string, options?: { changed?: readonly string[] }): Promise<SnapshotV2>;
}

export function exitCodeFor(violations: readonly Violation[], environment: readonly EnvironmentError[]): ExitCode {
  if (environment.length > 0) return EXIT_CODES.environment;
  return violations.length > 0 ? EXIT_CODES.violations : EXIT_CODES.ok;
}

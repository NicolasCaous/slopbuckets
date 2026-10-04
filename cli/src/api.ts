// Programmatic API. The examples battery imports these functions from source.
import * as adapterTs from '@slopbuckets/adapter-ts';
import { runCheck } from './core/check.js';
import { discoverProjects, joinReports, runRecursiveCheck } from './core/recursive.js';
import { writeLockFile } from './core/lock.js';
import { EnvironmentError, type CheckReport, type Context, type Lock } from './core/types.js';
import { CLI_VERSION } from './version.js';

export type { Adapter, CheckReport, Context, EnvironmentCode, Lock, LockChange, LockChangeKind, RuleId, Violation } from './core/types.js';
export { EnvironmentError } from './core/types.js';

/** The context with the real TypeScript adapter. */
export function defaultContext(): Context {
  return { adapter: adapterTs, cliVersion: CLI_VERSION };
}

/**
 * Runs `buckets check` on a project folder and, unless `recursive` is false, on every project nested in it.
 * With `file`, checks only that file in `projectDir` (no orphan rule, no lock comparison, no nested projects).
 */
export async function check(projectDir: string, options: { file?: string; recursive?: boolean } = {}, ctx: Context = defaultContext()): Promise<CheckReport> {
  if (options.file !== undefined) return joinReports([{ path: '.', report: (await runCheck(ctx, projectDir, { file: options.file })).report }]);
  return (await runRecursiveCheck(ctx, projectDir, { recursive: options.recursive ?? true })).report;
}

/** The project folder and the projects nested in it, as absolute folders with their path relative to `projectDir`. */
export function listProjects(projectDir: string, ctx: Context = defaultContext()): { path: string; dir: string }[] {
  return discoverProjects(ctx, projectDir);
}


/**
 * Computes the lock for the current state of a project, whether or not the rules pass.
 * Throws an EnvironmentError when the project cannot be analyzed, and an Error when the config is invalid.
 */
export async function computeLock(projectDir: string, ctx: Context = defaultContext()): Promise<Lock> {
  const result = await runCheck(ctx, projectDir, { ignoreVersions: true });
  const env = result.report.environment;
  if (env) throw new EnvironmentError(env.code, env.message);
  if (!result.lock) {
    const reasons = result.report.violations.map((v) => `${v.file}: ${v.message}`).join('\n');
    throw new Error(`Cannot compute the lock for ${projectDir}:\n${reasons}`);
  }
  return result.lock;
}

/** Writes buckets.lock.json with sorted keys, 2-space indentation and a trailing newline. */
export async function writeLock(projectDir: string, lock: Lock): Promise<void> {
  await writeLockFile(projectDir, lock);
}

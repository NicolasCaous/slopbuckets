// The decisions of the slopbuckets hooks, for any agent harness. An adapter turns a harness payload into one of the
// calls below and turns the answer into the harness output. Nothing here reads stdin, writes stdout or knows a tool name.
//
// - preTool: before a tool runs. Denies a write to any buckets.lock.json or buckets.config.json, any
//   `buckets refresh` but `--web` and any `buckets update` without `--check` or `--json`.
// - postEdit: after files were written. Returns the `buckets check --file` report of the files with problems.
// - stop: before the agent (or a subagent) ends its turn. Returns the full check report when it fails.
//
// None of them throws. An unexpected error comes back in `error`, for the adapter to print on stderr, and the answer
// follows the rule of hookFailure below: a crash never lets the agent finish with unchecked work.
import path from 'node:path';
import { CACHE_DIR } from '../core/cache.js';
import { runCheck } from '../core/check.js';
import { loadConfig } from '../core/config.js';
import { diskCase, relativeToProject } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import { runRecursiveCheck } from '../core/recursive.js';
import type { CheckReport, Context } from '../core/types.js';
import { formatReport } from '../output/text.js';
import {
  guardedAboveProjects,
  guardedByIdentity,
  guardedName,
  mentionsConfig,
  mentionsLock,
  normalizeTargetPath,
  runsForbiddenRefresh,
  runsInstallingUpdate,
  sameFile,
  type GuardedFile,
} from './lock-guard.js';
import { liveSessionProjects, readSessionProjects, recordSessionProject, sessionStateFile } from './session.js';

export const LOCK_DENY_REASON =
  'buckets.lock.json records the contracts a human approved, and only a human may change it: with `buckets refresh` in their own terminal, or by confirming the approval that `buckets refresh --web` asks for. ' +
  'Do not edit or write the lock under any name (alternative streams, short names, links), do not run shell commands that mention it, also through wildcards, and do not run `buckets refresh` with anything but exactly the `--web` flag. Output redirections such as `> refresh.log 2>&1`, a pipe to `tee` and a trailing `&` are allowed after `--web`. To read the lock, use the Read tool. ' +
  'If `buckets check` reports lock differences (exit code 2), run `buckets refresh --web` in the background, send the link it prints to the human with a summary of which DMZ files changed and why, and wait for the command to finish.';

export const CONFIG_DENY_REASON =
  'buckets.config.json belongs to the human: it sets the root bucket folder, the import alias and the `access` rules that decide which buckets may use which, in this project and in every nested project. ' +
  'Do not edit or write any buckets.config.json under any name (alternative streams, short names, links), and do not run shell commands that mention it, also through wildcards. To read it, use the Read tool. ' +
  'A shell glob that can match buckets.config.json, such as `*config*` or `*.config.json`, counts as naming it, so to list or search files use your file reading or search tool instead of the shell. ' +
  'If a task needs a change in it, such as an `access` line that allows a dependency, stop and ask the human to make the change, with the exact lines you need and why.';

export const UPDATE_DENY_REASON =
  'Only a human updates the slopbuckets CLI, because the lock of each project records the CLI version that a human approved. ' +
  'Do not run `buckets update` without `--check` or `--json`, also through npx, pnpm, yarn, bunx or a path to the CLI. `buckets update --check` and `buckets update --json` only report, so you may run them. ' +
  'If a notice said that a newer slopbuckets version is available, tell the human the version it showed, and ask them to run `buckets update` in their own terminal.';

/** What the guard refuses: a write to a guarded file, or a `buckets update` that can install. */
export type Guarded = GuardedFile | 'update';

const DENY_REASONS: Record<Guarded, string> = { lock: LOCK_DENY_REASON, config: CONFIG_DENY_REASON, update: UPDATE_DENY_REASON };

/** The first line of a stop report, by exit code. Exit 2 needs a human, so the agent must not try to fix it. */
export const STOP_INTRO: Record<0 | 1 | 2 | 3, string> = {
  0: '',
  1: 'buckets check found broken bucket rules, so you cannot finish yet. The report below says how to fix each one.',
  2: 'buckets check passes the rules, but the project differs from its buckets.lock.json (contracts, buckets, nested projects or links), and only a human can approve that. Ask for the approval with `buckets refresh --web`, as the last line of the report says.',
  3: 'buckets check could not run, so the bucket rules were not verified. Stop and show the message below to the human.',
};

/** What a tool call is about to do, as far as the lock guard cares. */
export type ToolAction =
  /** The tool writes, edits, deletes or moves these files. Relative paths resolve from the call's `cwd`. */
  | { kind: 'write'; paths: string[] }
  /** The tool runs this shell command. `cwd` is its working folder when the harness reports one apart from the call's. */
  | { kind: 'shell'; command: string; cwd?: string }
  /** Anything else, such as a read or a search. Always allowed. */
  | { kind: 'other' };

/** Where a hook call happens. Every adapter fills it from its payload. */
export interface HookScope {
  /**
   * The folder the session was opened in: Claude Code's `CLAUDE_PROJECT_DIR` or a workspace root. It may be a
   * project, a folder inside one or a folder above several projects. Defaults to `cwd`.
   */
  projectDir?: string;
  /** The working folder of the call. Relative paths resolve from it. */
  cwd: string;
  /** The session id, which keys the projects recorded in a session opened above the projects. Optional. */
  sessionId?: string;
}

export interface PreToolInput extends HookScope {
  action: ToolAction;
}

export type PreToolResult = { decision: 'allow'; error?: string } | { decision: 'deny'; reason: string };

export interface PostEditInput extends HookScope {
  /** Files the tool wrote. Each one is checked with `buckets check --file` in its nearest project. */
  paths: string[];
  /** Files the tool wrote that are not checked, such as notebooks. They only record their project for the session. */
  touched?: string[];
}

export interface PostEditResult {
  /** The report to hand to the model, when a file has problems or the check crashed. */
  feedback?: string;
  error?: string;
}

export interface StopInput extends HookScope {
  /** True when this stop already follows a block of this hook (Claude Code's `stop_hook_active`). Nothing runs then. */
  active: boolean;
  /** True for the end of a subagent's work. The check is the same; adapters may phrase the output differently. */
  subagent: boolean;
}

export interface StopResult {
  /** The report that keeps the agent from finishing, once. */
  block?: string;
  error?: string;
}

/** The session folder and whether a project holds it. */
function locate(scope: HookScope): { sessionDir: string; projectDir: string | null } {
  const start = scope.projectDir ?? scope.cwd;
  return { sessionDir: path.resolve(start), projectDir: findProjectDir(start) };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * The guarded file that writing `file` would write: a lock or a config. A name check alone without `where`. With
 * `where`, a path that does not name one is also compared with the real files on disk (short names, hard links,
 * symbolic links). Null when it writes neither.
 */
export function guardedWrite(file: string, where?: { projectDir: string; cwd: string }): GuardedFile | null {
  const { dir, base } = normalizeTargetPath(file);
  const named = guardedName(base);
  if (named !== null) return named;
  if (where === undefined || base === '') return null;
  return guardedByIdentity(path.resolve(where.cwd, dir === '' ? '.' : dir, base), base, where.projectDir);
}

/** True when writing `file` would write a lock or a config, as `guardedWrite` reads it. */
export function isLockWrite(file: string, where?: { projectDir: string; cwd: string }): boolean {
  return guardedWrite(file, where) !== null;
}

/**
 * What a shell command touches that the guard refuses: the guarded file it names, `lock` when it runs
 * `buckets refresh` in any form but `--web`, or `update` when it runs `buckets update` without `--check` or `--json`.
 */
export function guardedShell(command: string): Guarded | null {
  if (mentionsLock(command) || runsForbiddenRefresh(command)) return 'lock';
  if (mentionsConfig(command)) return 'config';
  return runsInstallingUpdate(command) ? 'update' : null;
}

/**
 * True when a shell command names a lock or a config, runs `buckets refresh` in any form but `--web`, or runs
 * `buckets update` without `--check` or `--json`.
 */
export function isForbiddenShell(command: string): boolean {
  return guardedShell(command) !== null;
}

/**
 * The guard of the lock and the config. A crash allows the call, because a crash here would break every tool call
 * the agent makes.
 */
export function preTool(input: PreToolInput): PreToolResult {
  const deny = (kind: Guarded): PreToolResult => ({ decision: 'deny', reason: DENY_REASONS[kind] });
  try {
    const { action } = input;
    if (action.kind === 'other') return { decision: 'allow' };
    const { sessionDir, projectDir } = locate(input);
    if (action.kind === 'shell') {
      const guarded = guardedShell(action.command);
      if (guarded !== null) return deny(guarded);
      // A session above the projects records the project of every shell command, so its stop hook checks it.
      if (projectDir === null) {
        const cwd = path.resolve(sessionDir, action.cwd ?? input.cwd);
        const project = findProjectDir(cwd);
        if (project !== null) recordSessionProject(sessionStateFile(input.sessionId), project);
      }
      return { decision: 'allow' };
    }
    if (projectDir !== null) {
      for (const file of action.paths) {
        const guarded = guardedWrite(file, { projectDir, cwd: input.cwd });
        if (guarded !== null) return deny(guarded);
      }
      return { decision: 'allow' };
    }
    const stateFile = sessionStateFile(input.sessionId);
    const recorded = () => (stateFile === null ? [] : readSessionProjects(stateFile).projects);
    const cwd = path.resolve(sessionDir, input.cwd);
    for (const file of action.paths) {
      const guarded = guardedAboveProjects(file, cwd, sessionDir, recorded);
      if (guarded !== null) return deny(guarded);
    }
    return { decision: 'allow' };
  } catch (error) {
    return { decision: 'allow', error: errorDetail(error) };
  }
}

const FAILURE_ADVICE =
  'Report this error to the human: it is a bug in slopbuckets or a problem in the environment, and the bucket rules were not verified. ' +
  'Do not try to work around it by editing slopbuckets, the lock or the hook settings.';

/**
 * `buckets check --file` on each file the agent just wrote, in the nearest project of the file. Inside a project, only
 * files of that project and of the projects nested in it count. In a session opened above the projects, each file
 * records its project for the stop hook.
 */
export async function postEdit(ctx: Context, input: PostEditInput): Promise<PostEditResult> {
  // True once the hook works on a project, so a crash after that point reports instead of passing silently.
  let inProject = false;
  try {
    const { sessionDir, projectDir } = locate(input);
    const sections: string[] = [];
    if (projectDir !== null) {
      inProject = true;
      for (const file of input.paths) {
        const absolute = path.resolve(input.cwd, file);
        // The edited file belongs to the nearest project above it: the session's project or one nested in it.
        const fileProject = findProjectDir(path.dirname(absolute));
        if (fileProject === null) continue;
        const nested = relativeToProject(projectDir, fileProject);
        if (nested === null) continue;
        const where = nested === '' ? '' : ` in the nested project ${nested} (the paths below are relative to it)`;
        const report = await checkEditedFile(ctx, absolute, fileProject, path.join(projectDir, CACHE_DIR), where);
        if (report !== null) sections.push(report);
      }
    } else {
      const stateFile = sessionStateFile(input.sessionId);
      const cwd = path.resolve(sessionDir, input.cwd);
      const checked = new Set(input.paths);
      for (const file of [...input.paths, ...(input.touched ?? [])]) {
        const absolute = path.resolve(cwd, file);
        const fileProject = findProjectDir(path.dirname(absolute));
        if (fileProject === null) continue;
        inProject = true;
        recordSessionProject(stateFile, fileProject);
        if (!checked.has(file)) continue;
        const where = ` in the project ${fileProject} (the paths below are relative to it)`;
        const report = await checkEditedFile(ctx, absolute, fileProject, path.join(fileProject, CACHE_DIR), where);
        if (report !== null) sections.push(report);
      }
    }
    return sections.length > 0 ? { feedback: sections.join('\n\n') } : {};
  } catch (error) {
    const detail = errorDetail(error);
    if (!inProject) return { error: detail };
    return { feedback: `buckets check --file crashed with an unexpected error after your edit:\n\n${detail}\n\n${FAILURE_ADVICE}`, error: detail };
  }
}

/** The report of `buckets check --file` on a file inside the root bucket folder of its project, or null when it is clean. */
async function checkEditedFile(ctx: Context, absolute: string, fileProject: string, cacheDir: string, where: string): Promise<string | null> {
  const config = loadConfig(fileProject);
  if (config.kind !== 'ok') return null;
  const typed = relativeToProject(fileProject, absolute);
  // On a file system that ignores case, the agent may spell the path with other case than the disk.
  const rel = typed === null ? null : diskCase(fileProject, typed);
  const root = config.config.root;
  if (rel === null || (rel !== root && !rel.startsWith(`${root}/`))) return null;
  const result = await runCheck(ctx, fileProject, { file: absolute, cacheDir });
  if (result.report.violations.length === 0) return null;
  return `buckets check --file ${rel} found problems in the file you just edited${where}. Fix them before you continue.\n\n${formatReport(result.report, [], { file: rel })}`;
}

function chainsOf(runs: Awaited<ReturnType<typeof runRecursiveCheck>>['runs']) {
  return runs.flatMap((run) => run.result.orphanChains.map((chain) => ({ ...chain, project: run.path })));
}

function samePath(a: string, b: string): boolean {
  return sameFile(path.resolve(a), path.resolve(b));
}

/**
 * The full check before the agent finishes. Inside a project: the project and every project nested in it, like
 * `buckets check`. Above the projects: each project the session recorded, in one report that names each folder.
 */
export async function stop(ctx: Context, input: StopInput): Promise<StopResult> {
  if (input.active) return {};
  let inProject = false;
  try {
    const { projectDir } = locate(input);
    if (projectDir !== null) {
      inProject = true;
      const { report, runs } = await runRecursiveCheck(ctx, projectDir, { cacheDir: path.join(projectDir, CACHE_DIR) });
      if (report.exitCode === 0) return {};
      return { block: `${STOP_INTRO[report.exitCode]}\n\n${formatReport(report, chainsOf(runs))}` };
    }
    const recorded = liveSessionProjects(sessionStateFile(input.sessionId));
    if (recorded.length === 0) return {};
    inProject = true;
    // Outer projects first, so a project nested in one already checked is not checked twice.
    const ordered = [...recorded].sort((a, b) => a.length - b.length);
    const covered: string[] = [];
    const checked: { dir: string; report: CheckReport; chains: ReturnType<typeof chainsOf> }[] = [];
    for (const dir of ordered) {
      if (covered.some((done) => samePath(done, dir))) continue;
      const { report, runs } = await runRecursiveCheck(ctx, dir, { cacheDir: path.join(dir, CACHE_DIR) });
      covered.push(...runs.map((run) => run.dir));
      checked.push({ dir, report, chains: chainsOf(runs) });
    }
    const failed = checked.filter((c) => c.report.exitCode !== 0);
    if (failed.length === 0) return {};
    const intro =
      checked.length === 1
        ? 'buckets check failed in the project this session changed.'
        : `buckets check failed in ${failed.length} of the ${checked.length} projects this session changed.`;
    const sections = failed.map((c) => `--- Project folder: ${c.dir}\n\n${STOP_INTRO[c.report.exitCode]}\n\n${formatReport(c.report, c.chains)}`);
    return {
      block: `${intro} Each section below starts with the project folder. Run the commands a section asks for, such as \`buckets refresh --web\`, in that folder.\n\n${sections.join('\n\n')}`,
    };
  } catch (error) {
    const detail = errorDetail(error);
    if (!inProject) return { error: detail };
    return { block: `buckets check crashed with an unexpected error before you finished:\n\n${detail}\n\n${FAILURE_ADVICE}`, error: detail };
  }
}

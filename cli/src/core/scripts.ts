// The `scripts` key of buckets.config.json: Node scripts whose output lines join the groups of access and layout lines
// that name them in backticks, such as {A,`repos`}. The threat model covers honest mistakes, so there is no sandbox:
// each script runs as `node <file>` in the project folder.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ScriptValues } from './bucket-glob.js';
import type { ResolvedConfig } from './config.js';
import { CONFIG_FILE } from './paths.js';
import type { Context, Violation } from './types.js';

/** How long a script may run, in milliseconds. */
export const SCRIPT_TIMEOUT_MS = 10_000;

/** What one run of a script gave. `error` names a failure to start it. */
export interface ScriptRun {
  /** The exit code, or null when the process did not exit by itself. */
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** Runs the script `file` (absolute) with `cwd` as the current folder. */
export type ScriptRunner = (file: string, cwd: string) => ScriptRun;

/**
 * Runs a script with the Node binary that runs this CLI: `process.execPath` with the script as its only argument and
 * no shell, so a path with spaces needs no quoting on Windows and the timeout stops the script itself.
 */
export function runNodeScript(file: string, cwd: string): ScriptRun {
  const result = spawnSync(process.execPath, [file], {
    cwd,
    encoding: 'utf8',
    timeout: SCRIPT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const run: ScriptRun = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', timedOut: code === 'ETIMEDOUT' };
  if (result.error !== undefined && !run.timedOut) run.error = result.error.message;
  return run;
}

/** The runs of one check, by script file and folder. See `withScriptRuns`. */
export type ScriptRuns = Map<string, ScriptRun>;

/**
 * A copy of `ctx` that remembers the runs of its scripts, so each script runs at most once while the copy is in use.
 * Each check (`runRecursiveCheck`, `buildSnapshot`, a review) makes its own copy, so the next check runs the scripts
 * again and sees what they print by then.
 */
export function withScriptRuns<C extends object>(ctx: C): C & { scriptRuns: ScriptRuns } {
  return { ...ctx, scriptRuns: new Map() };
}

function runOnce(run: ScriptRunner, done: ScriptRuns | undefined, file: string, cwd: string): ScriptRun {
  if (done === undefined) return run(file, cwd);
  const key = `${path.resolve(file)}\0${path.resolve(cwd)}`;
  let result = done.get(key);
  if (result === undefined) {
    result = run(file, cwd);
    done.set(key, result);
  }
  return result;
}

/** Characters a value may not hold: path separators, glob syntax, characters Windows forbids, and control characters. */
const FORBIDDEN = /[/\\*{}<>,|`":?\u0000-\u001f]/;

/** The names Windows reserves for devices, alone or before an extension, in any case. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Why `value` is not a valid bucket name, or null. */
export function bucketNameProblem(value: string): string | null {
  if (FORBIDDEN.test(value)) return 'it holds a path separator, a glob character or a character that folder names cannot hold';
  if (value.trim() !== value) return 'it starts or ends with a space';
  if (value.endsWith('.')) return 'Windows cannot create a folder whose name ends with "."';
  if (RESERVED.test(value)) return `Windows reserves the name "${value.split('.')[0]}" for a device, so no folder can have it`;
  if (value.startsWith('.')) return 'bucket names cannot start with "."';
  if (value === '_' || value === 'dmz') return `"${value}" is a folder of every bucket, not a bucket name`;
  return null;
}

/** The first lines of the error output of a script, for a message. */
function stderrHead(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return ' It printed nothing on stderr.';
  const head = lines.slice(0, 5).map((line) => JSON.stringify(line.length > 200 ? `${line.trim().slice(0, 200)}...` : line.trim()));
  return ` Its stderr begins with ${head.length === 1 ? 'this line' : 'these lines'}: ${head.join(', ')}.`;
}

/** The values a script printed, sorted and without duplicates, or what is wrong with its run. */
export function scriptValues(run: ScriptRun): { values: string[] } | { problem: string } {
  const why = stderrHead(run.stderr);
  if (run.timedOut) return { problem: `did not finish within ${SCRIPT_TIMEOUT_MS / 1000} seconds and was stopped.${why}` };
  if (run.error !== undefined) return { problem: `could not start: ${run.error}.` };
  if (run.status !== 0) return { problem: `${run.status === null ? 'was stopped before it exited' : `exited with code ${run.status}`}.${why}` };
  const values = new Set<string>();
  for (const raw of run.stdout.split('\n')) {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (value === '') continue;
    const problem = bucketNameProblem(value);
    // The value is the problem here, so stderr is worth showing only when the script wrote something there.
    if (problem !== null) return { problem: `printed ${JSON.stringify(value)}, which is not a valid bucket name: ${problem}.${run.stderr.trim() === '' ? '' : why}` };
    values.add(value);
  }
  if (values.size === 0) return { problem: `printed no values.${why}` };
  return { values: [...values].sort() };
}

/**
 * Runs every script of the config with the runner of `ctx` (the real one by default), at most once while
 * `ctx.scriptRuns` stays the same (see `withScriptRuns`), and returns the values of each, by name. Each problem is a
 * config-invalid violation. Every script runs, so one failing script does not hide the problems of the others.
 */
export function resolveScripts(ctx: Pick<Context, 'runScript' | 'scriptRuns'>, projectDir: string, config: ResolvedConfig): { values: ScriptValues } | { violations: Violation[] } {
  const run = ctx.runScript ?? runNodeScript;
  // No prototype, so the values stay ordinary keys whatever the script names are.
  const values: Record<string, string[]> = Object.create(null);
  const violations: Violation[] = [];
  for (const name of Object.keys(config.scripts ?? {}).sort()) {
    const file = config.scripts![name]!;
    const result = scriptValues(runOnce(run, ctx.scriptRuns, path.resolve(projectDir, file), projectDir));
    if ('values' in result) {
      values[name] = result.values;
      continue;
    }
    violations.push({
      rule: 'config-invalid',
      file: CONFIG_FILE,
      message: `The script "${name}" (${file}) of ${CONFIG_FILE} ${result.problem} A script prints one bucket name per line on stdout and exits with code 0. Its values join the groups of the access and layout lines that name it in backticks. Fix the script or the files it reads, then run the check again. If the script is right and the config must change, stop and ask the human, because ${CONFIG_FILE} belongs to a human.`,
    });
  }
  return violations.length > 0 ? { violations } : { values };
}

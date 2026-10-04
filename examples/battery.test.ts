// End-to-end battery for the buckets CLI. Each folder examples/<case>/ with a
// case.json is one test. The format is described in examples/README.md and in
// SPEC.md, section "Bateria de exemplos".
//
// Each run works in its own folder, examples/.tmp/battery-<pid>-<time>/ (RUN_DIR
// below), so runs that overlap never touch each other's files. Before the first
// case, the battery copies cli/dist/ to RUN_DIR/.cli/, so a build started by
// another process while the cases run cannot remove the CLI under them.
//
// For each case the battery:
//   1. copies <case>/project/ to RUN_DIR/<case>/ (inside the repository, so the
//      root `typescript` package resolves from the copy)
//   2. prepares the lock ("fresh" calls computeLock + writeLock)
//   3. copies <case>/after/ over the copy and applies "delete"
//   4. runs `node RUN_DIR/.cli/cli/dist/index.js ...args` in the copy, with
//      CLAUDE_PROJECT_DIR pointing at it (or at RUN_DIR, its parent folder, with
//      "claudeProjectDir": "parent") and "stdin" piped as JSON
//   5. compares the result with "expect"
//
// When every case passes, the battery removes RUN_DIR. When a case fails, it
// keeps RUN_DIR so the failing copy can be inspected, and prints its path.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  REPO_DIR,
  caseArgs,
  isCheckJson,
  listCaseNames,
  loadCase,
  runDir,
  validateCase,
  type ExpectedLockChange,
  type ExpectedViolation,
  type LoadedCase,
} from './case-format.js';

const RUN_DIR = runDir('battery');
const BUILT_DIST = path.join(REPO_DIR, 'cli', 'dist');
/** The files a complete `npm run build` leaves in cli/dist/. tsup empties the folder first and writes them in this order. */
const DIST_FILES = ['index.js', 'inspect-static.js'];
/** The private copy of the CLI. It keeps the cli/ folder name so the CLI finds its package.json and the skill as in a checkout. */
const CLI_COPY = path.join(RUN_DIR, '.cli');
const CLI_PATH = path.join(CLI_COPY, 'cli', 'dist', 'index.js');
const RUN_TIMEOUT_MS = 50_000;
const OUTPUT_LIMIT = 4_000;
/** How long to wait for a build that another process is running to finish before giving up. */
const BUILD_WAIT_MS = 90_000;

interface ActualViolation {
  rule: string;
  file: string;
  line?: number;
  message?: string;
  project?: string;
}

interface ActualLockChange {
  kind: string;
  path: string;
  symbol?: string;
  message?: string;
  project?: string;
}

interface LockApi {
  computeLock(projectDir: string): Promise<object>;
  writeLock(projectDir: string, lock: object): Promise<void>;
  /** Optional: the project and its nested projects. Without it, only the top project gets a fresh lock. */
  listProjects?(projectDir: string): { path: string; dir: string }[];
}

let lockApi: Promise<LockApi> | undefined;

/** Loads computeLock and writeLock lazily, so cases that do not need a lock still run when the API is missing or broken. */
function loadLockApi(): Promise<LockApi> {
  lockApi ??= import('../cli/src/api.js').then((loaded: unknown) => {
    const module = loaded as Partial<LockApi>;
    if (typeof module.computeLock !== 'function' || typeof module.writeLock !== 'function') {
      throw new Error('cli/src/api.ts must export computeLock(projectDir) and writeLock(projectDir, lock)');
    }
    return module as LockApi;

  });
  return lockApi;
}

class CaseFailure extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Copies cli/dist/, cli/package.json and skill/SKILL.md into RUN_DIR/.cli/. When another process is rebuilding the CLI,
 * cli/dist/ is empty or half written for a few seconds, so the copy waits until every built file is there.
 * Returns an error message, or null when the copy is ready.
 */
async function copyCli(): Promise<string | null> {
  if (!existsSync(BUILT_DIST)) return 'cli/dist/ not found. Run "npm run build" first.';
  const deadline = Date.now() + BUILD_WAIT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    if (DIST_FILES.every((file) => existsSync(path.join(BUILT_DIST, file)))) {
      try {
        rmSync(CLI_COPY, { recursive: true, force: true });
        cpSync(BUILT_DIST, path.join(CLI_COPY, 'cli', 'dist'), { recursive: true });
        cpSync(path.join(REPO_DIR, 'cli', 'package.json'), path.join(CLI_COPY, 'cli', 'package.json'));
        cpSync(path.join(REPO_DIR, 'skill', 'SKILL.md'), path.join(CLI_COPY, 'skill', 'SKILL.md'));
        // With a package.json next to skill/, the CLI treats the copy as a repository checkout and installs skill/SKILL.md.
        writeFileSync(path.join(CLI_COPY, 'package.json'), '{ "private": true }\n');
        if (DIST_FILES.every((file) => existsSync(path.join(CLI_COPY, 'cli', 'dist', file)))) return null;
        lastError = 'a build removed cli/dist/ while it was being copied';
      } catch (error) {
        // A build that starts during the copy removes files under it.
        lastError = describeError(error);
      }
    } else {
      lastError = `cli/dist/ is missing ${DIST_FILES.filter((file) => !existsSync(path.join(BUILT_DIST, file))).join(' and ')}`;
    }
    await sleep(500);
  }
  return `could not copy cli/dist/ within ${BUILD_WAIT_MS / 1000} seconds (${lastError}). Run "npm run build" and try again.`;
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n... (${text.length - OUTPUT_LIMIT} more characters)` : text;
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Replaces ${PROJECT} in every string of the stdin object with the absolute path of the temporary project.
 * In a string that starts with the placeholder, the rest of the path gets native separators, like the paths
 * Claude Code sends. Segments such as ".." are kept, so cases can test path resolution.
 */
function substituteProject(value: unknown, projectDir: string): unknown {
  if (typeof value === 'string') {
    const placeholder = '${PROJECT}';
    if (value.startsWith(placeholder)) return projectDir + value.slice(placeholder.length).split('/').join(path.sep);
    return value.split(placeholder).join(projectDir);
  }
  if (Array.isArray(value)) return value.map((item) => substituteProject(item, projectDir));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteProject(item, projectDir)]));
  }
  return value;
}

/** Maps every file under dir to the sha256 of its content, keyed by a "/" separated relative path. */
function snapshotTree(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        result.set(`${relative}/`, 'dir');
        walk(full, relative);
      } else {
        result.set(relative, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    }
  };
  walk(dir, '');
  return result;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) changes.push(`added ${file}`);
    else if (before.get(file) !== hash) changes.push(`changed ${file}`);
  }
  for (const file of before.keys()) if (!after.has(file)) changes.push(`removed ${file}`);
  return changes;
}

/** Partial deep match: every key in expected must match in actual. Arrays must have the same length. Returns the mismatches. */
function partialMatch(expected: unknown, actual: unknown, where = 'stdout'): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${where}: expected an array, got ${JSON.stringify(actual)}`];
    if (expected.length !== actual.length) return [`${where}: expected ${expected.length} items, got ${actual.length}`];
    return expected.flatMap((item, index) => partialMatch(item, actual[index], `${where}[${index}]`));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      return [`${where}: expected an object, got ${JSON.stringify(actual)}`];
    }
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).flatMap(([key, item]) => partialMatch(item, record[key], `${where}.${key}`));
  }
  return Object.is(expected, actual) ? [] : [`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

function fileMatches(expected: string | string[], actual: string): boolean {
  return typeof expected === 'string' ? expected === actual : expected.includes(actual);
}

function formatViolation(item: ExpectedViolation | ActualViolation): string {
  const file = `${item.project !== undefined && item.project !== '.' ? `${item.project}: ` : ''}${Array.isArray(item.file) ? `one of [${item.file.join(', ')}]` : item.file}`;
  const line = item.line === undefined ? '' : `:${item.line}`;
  const message = 'message' in item && item.message ? `  (${item.message})` : '';
  return `${item.rule}  ${file}${line}${message}`;
}

function formatLockChange(item: ExpectedLockChange | ActualLockChange): string {
  const symbol = item.symbol === undefined ? '' : `#${item.symbol}`;
  const message = 'message' in item && item.message ? `  (${item.message})` : '';
  const project = item.project !== undefined && item.project !== '.' ? `${item.project}: ` : '';
  return `${item.kind}  ${project}${item.path}${symbol}${message}`;
}

/** Set comparison on (rule, file). Line is compared only when the case gives one. */
function compareViolations(expected: ExpectedViolation[], actual: ActualViolation[]): string[] {
  const missing = expected.filter(
    (exp) =>
      !actual.some(
        (act) =>
          act.rule === exp.rule &&
          fileMatches(exp.file, act.file) &&
          (exp.line === undefined || exp.line === act.line) &&
          (exp.project === undefined || exp.project === (act.project ?? '.')),
      ),
  );
  const unexpected = actual.filter(
    (act) => !expected.some((exp) => exp.rule === act.rule && fileMatches(exp.file, act.file) && (exp.project === undefined || exp.project === (act.project ?? '.'))),
  );
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing violations:\n${missing.map((item) => `    - ${formatViolation(item)}`).join('\n')}`);
  if (unexpected.length > 0) problems.push(`unexpected violations:\n${unexpected.map((item) => `    + ${formatViolation(item)}`).join('\n')}`);
  return problems;
}

/** Set comparison on (kind, path). Symbol is compared only when the case gives one. */
function compareLockChanges(expected: ExpectedLockChange[], actual: ActualLockChange[]): string[] {
  const missing = expected.filter(
    (exp) =>
      !actual.some(
        (act) =>
          act.kind === exp.kind &&
          act.path === exp.path &&
          (exp.symbol === undefined || exp.symbol === act.symbol) &&
          (exp.project === undefined || exp.project === (act.project ?? '.')),
      ),
  );
  const unexpected = actual.filter(
    (act) => !expected.some((exp) => exp.kind === act.kind && exp.path === act.path && (exp.project === undefined || exp.project === (act.project ?? '.'))),
  );
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing lock changes:\n${missing.map((item) => `    - ${formatLockChange(item)}`).join('\n')}`);
  if (unexpected.length > 0) problems.push(`unexpected lock changes:\n${unexpected.map((item) => `    + ${formatLockChange(item)}`).join('\n')}`);
  return problems;
}

async function prepareProject(loaded: LoadedCase, workDir: string): Promise<void> {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  cpSync(loaded.projectDir, workDir, { recursive: true });

  const { spec } = loaded;
  for (const args of spec.setup ?? []) {
    const result = runCli(args, workDir, '');
    if (result.status !== 0) {
      throw new CaseFailure(`setup command "buckets ${args.join(' ')}" exited with ${result.status}:\n${truncate(`${result.stdout ?? ''}${result.stderr ?? ''}`)}`);
    }
  }
  if (spec.lock === 'fresh') {
    let api: LockApi;
    try {
      api = await loadLockApi();
    } catch (error) {
      throw new CaseFailure(`could not load computeLock/writeLock from cli/src/api.ts:\n${describeError(error)}`);
    }
    try {
      // Every project gets a fresh lock: the top one, with lockPatch, and each nested one.
      const projects = api.listProjects ? api.listProjects(workDir) : [{ path: '.', dir: workDir }];
      for (const project of projects) {
        const lock = await api.computeLock(project.dir);
        await api.writeLock(project.dir, spec.lockPatch && project.path === '.' ? { ...lock, ...spec.lockPatch } : lock);
      }
    } catch (error) {
      throw new CaseFailure(`computeLock/writeLock failed on ${workDir}:\n${describeError(error)}`);
    }
    if (!existsSync(path.join(workDir, 'buckets.lock.json'))) {
      throw new CaseFailure('writeLock did not create buckets.lock.json');
    }
  }

  if (loaded.afterDir !== null) cpSync(loaded.afterDir, workDir, { recursive: true, force: true });
  for (const item of spec.delete ?? []) {
    const target = path.join(workDir, item);
    if (!existsSync(target)) throw new CaseFailure(`"delete" entry ${item} does not exist in the prepared project`);
    rmSync(target, { recursive: true, force: true });
  }
}

function runCli(args: string[], workDir: string, stdin: string, claudeProjectDir = workDir): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: workDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: claudeProjectDir, NO_COLOR: '1', FORCE_COLOR: '0' },
    input: stdin,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
  });
}

async function runCase(name: string): Promise<void> {
  const loaded = loadCase(name);
  const problems = validateCase(loaded);
  if (problems.length > 0) throw new Error(`invalid case.json (see fixtures.test.ts):\n  ${problems.join('\n  ')}`);

  const { spec } = loaded;
  const args = caseArgs(spec);
  const workDir = path.join(RUN_DIR, name);
  const command = `node ${CLI_PATH} ${args.join(' ')}`;
  const header = `case ${name}: ${spec.description}\n  command: ${command}\n  project: ${workDir}`;

  if (cliProblem !== null) throw new Error(`${header}\n\n${cliProblem}`);

  try {
    await prepareProject(loaded, workDir);
  } catch (error) {
    if (error instanceof CaseFailure) throw new Error(`${header}\n\nsetup failed: ${error.message}`);
    throw error;
  }

  const stdinText = spec.stdin == null ? '' : JSON.stringify(substituteProject(spec.stdin, workDir));
  // Extension: "claudeProjectDir": "parent" opens the session in the folder above the project copy, RUN_DIR.
  const claudeProjectDir = spec.claudeProjectDir === 'parent' ? path.dirname(workDir) : workDir;
  const result = runCli(args, workDir, stdinText, claudeProjectDir);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.status;

  const failures: string[] = [];
  if (result.error) failures.push(`the process failed to run: ${result.error.message}`);
  if (result.signal) failures.push(`the process was killed by ${result.signal}`);

  const { expect } = spec;
  if (expect.exitCode === 'nonzero') {
    if (exitCode === 0) failures.push('exit code: expected non-zero, got 0');
  } else if (exitCode !== expect.exitCode) {
    failures.push(`exit code: expected ${expect.exitCode}, got ${exitCode}`);
  }

  let json: unknown;
  let jsonError: string | undefined;
  const needsJson = isCheckJson(args) || expect.stdoutJson !== undefined || expect.violations !== undefined || expect.lockChanges !== undefined;
  if (needsJson) {
    try {
      json = JSON.parse(stdout);
    } catch (error) {
      jsonError = (error as Error).message;
      failures.push(`stdout is not valid JSON (${jsonError})`);
    }
  }

  if (json !== undefined && isCheckJson(args)) {
    const report = json as Record<string, unknown>;
    if (report.exitCode !== exitCode) failures.push(`report.exitCode is ${JSON.stringify(report.exitCode)} but the process exited with ${exitCode}`);
    if (!Array.isArray(report.violations)) failures.push('report.violations is not an array');
    if (!Array.isArray(report.lockChanges)) failures.push('report.lockChanges is not an array');
  }

  if (json !== undefined) {
    const report = json as { violations?: unknown; lockChanges?: unknown };
    if (expect.violations !== undefined && Array.isArray(report.violations)) {
      failures.push(...compareViolations(expect.violations, report.violations as ActualViolation[]));
    }
    if (expect.lockChanges !== undefined && Array.isArray(report.lockChanges)) {
      failures.push(...compareLockChanges(expect.lockChanges, report.lockChanges as ActualLockChange[]));
    }
    if (expect.stdoutJson !== undefined) failures.push(...partialMatch(expect.stdoutJson, json));
  }

  if (expect.stdoutEmpty === true && stdout.trim() !== '') failures.push('stdout: expected no output');
  if (expect.stdoutEmpty === false && stdout.trim() === '') failures.push('stdout: expected some output');

  const stderrExpected = typeof expect.stderrIncludes === 'string' ? [expect.stderrIncludes] : (expect.stderrIncludes ?? []);
  for (const text of stderrExpected) if (!stderr.includes(text)) failures.push(`stderr does not include ${JSON.stringify(text)}`);

  for (const file of expect.filesExist ?? []) if (!existsSync(path.join(workDir, file))) failures.push(`expected ${file} to exist`);
  for (const file of expect.filesMissing ?? []) if (existsSync(path.join(workDir, file))) failures.push(`expected ${file} not to exist`);

  if (expect.idempotent === true && failures.length === 0) {
    const first = snapshotTree(workDir);
    const second = runCli(args, workDir, stdinText, claudeProjectDir);
    if (second.status !== exitCode) failures.push(`second run: exit code ${second.status}, first run exited with ${exitCode}\n  stderr: ${truncate(second.stderr ?? '')}`);
    const changes = diffSnapshots(first, snapshotTree(workDir));
    if (changes.length > 0) failures.push(`second run changed the project:\n    ${changes.join('\n    ')}`);
  }

  if (failures.length > 0) {
    const shownStdout = json !== undefined ? JSON.stringify(json, null, 2) : stdout;
    throw new Error(
      [
        header,
        '',
        'mismatches:',
        ...failures.map((failure) => `  ${failure}`),
        '',
        `exit code: ${exitCode}`,
        `stdout:\n${truncate(shownStdout) || '(empty)'}`,
        `stderr:\n${truncate(stderr) || '(empty)'}`,
      ].join('\n'),
    );
  }
}

const caseNames = listCaseNames();
let cliProblem: string | null = 'the CLI copy was not made';
let failed = false;

describe('examples battery', () => {
  beforeAll(async () => {
    mkdirSync(RUN_DIR, { recursive: true });
    cliProblem = await copyCli();
  }, BUILD_WAIT_MS + 30_000);

  afterAll(() => {
    if (failed) {
      console.error(`examples battery: kept ${RUN_DIR} for inspection`);
      return;
    }
    try {
      // Retries cover Windows, where a CLI process that just exited can hold a handle for a moment.
      rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.error(`examples battery: could not remove ${RUN_DIR}: ${describeError(error)}`);
    }
  });

  test('finds at least one case', () => {
    if (caseNames.length === 0) throw new Error('no examples/<case>/case.json found');
  });

  for (const name of caseNames) {
    test(name, async () => {
      try {
        await runCase(name);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  }
});

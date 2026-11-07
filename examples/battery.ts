// End-to-end battery for the buckets CLI. Every folder examples/<case>/ with a case.json is one test. The files
// battery-<n>.test.ts each run one shard of the cases with battery(), and vitest runs the shards in parallel. The format is
// the contract in cli/src/testing/case-format.ts, and examples/README.md explains how the runner applies it.
//
// For each case the runner:
//   1. validates case.json against the contract and fails with every problem it finds
//   2. copies <case>/project/ to examples/.tmp/<run>/<case>/project/, with one <run> per shard, inside the repository so that the root
//      `typescript` package resolves from the copy, links npm workspaces into node_modules as npm install would, then
//      runs git init and commits, so the CLI sees the files through git
//   3. runs the setup commands, copies <case>/after/ over the copy and removes the paths in `delete`
//   4. runs cli/dist/index.js once with `args` (a command case), or once per step with `hook --agent <agent> <event>`
//      (a hook sequence that shares one session state), and compares each result with its `expect`
//
// The run folder is removed when every case passes, and kept for inspection when one fails.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { HOOK_PHASES } from '../cli/src/contract/hooks.js';
import { formatConfigPath } from '../cli/src/contract/messages.js';
import { ADVICE_IDS, RULE_IDS } from '../cli/src/contract/rules.js';
import { SESSIONS_DIR, parseSessionState, sessionFile } from '../cli/src/contract/session.js';
import { violationLocation, type Advice, type Violation } from '../cli/src/contract/violation.js';
import { isRecord } from '../cli/src/files/json.js';
import { DEFAULT_ARGS, isHookSequence, type CaseExpect, type CaseSpec, type ExpectedAdvice, type ExpectedViolation } from '../cli/src/testing/case-format.js';

const EXAMPLES_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(EXAMPLES_DIR);
const CLI_PATH = path.join(REPO_DIR, 'cli', 'dist', 'index.js');
/** Short on purpose: Windows paths stop at 260 characters in some tools. */
const RUN_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4_000;

// ---------------------------------------------------------------------------------------------------------------------
// Validation of case.json

const TOP_KEYS = ['description', 'setup', 'delete', 'claudeProjectDir', 'args', 'stdin', 'expect', 'steps'];
const STEP_KEYS = ['hook', 'event', 'agent', 'files', 'payload', 'expect'];
const EXPECT_KEYS = [
  'exitCode',
  'violations',
  'advice',
  'message',
  'messageIncludes',
  'pending',
  'decision',
  'stdoutJson',
  'stdoutEmpty',
  'stderrIncludes',
  'filesExist',
  'filesMissing',
  'idempotent',
];
const VIOLATION_KEYS = ['rule', 'file', 'line', 'project'];
const DECISIONS = ['silent', 'context', 'deny', 'block'];

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isRuleId = (v: unknown) => (RULE_IDS as readonly unknown[]).includes(v);
/** A relative path with `/` that stays inside the project copy. */
const isSafePath = (v: unknown) => typeof v === 'string' && v !== '' && !v.includes('\\') && !path.posix.isAbsolute(v) && !v.split('/').includes('..');

function unknownKeys(value: Record<string, unknown>, known: string[], where: string): string[] {
  return Object.keys(value)
    .filter((k) => !known.includes(k))
    .map((k) => `${where}: unknown field "${k}"`);
}

function validateExpect(value: unknown, where: string, hookStep: boolean, args: string[]): string[] {
  if (!isRecord(value)) return [`${where}: must be an object`];
  const p = unknownKeys(value, EXPECT_KEYS, where);
  const e = value as Record<keyof CaseExpect, unknown>;
  if (e.exitCode !== undefined && e.exitCode !== 'nonzero' && !Number.isInteger(e.exitCode)) p.push(`${where}.exitCode: must be an integer or "nonzero"`);
  if (e.violations !== undefined) {
    if (!Array.isArray(e.violations)) p.push(`${where}.violations: must be an array`);
    else
      e.violations.forEach((v: unknown, i) => {
        const at = `${where}.violations[${i}]`;
        if (!isRecord(v)) return void p.push(`${at}: must be an object`);
        p.push(...unknownKeys(v, VIOLATION_KEYS, at));
        if (!isRuleId(v.rule)) p.push(`${at}.rule: ${JSON.stringify(v.rule)} is not a rule id (${RULE_IDS.join(', ')})`);
        if (v.file !== undefined && typeof v.file !== 'string' && !(isStringArray(v.file) && v.file.length > 0)) p.push(`${at}.file: must be a string or a non-empty array of strings`);
        if (v.line !== undefined && !(Number.isInteger(v.line) && (v.line as number) > 0)) p.push(`${at}.line: must be a positive integer`);
        if (v.project !== undefined && typeof v.project !== 'string') p.push(`${at}.project: must be a string`);
      });
    if (!hookStep && !args.includes('--json')) p.push(`${where}.violations: needs --json in args, because only the JSON report lists violations`);
  }
  if (e.advice !== undefined) {
    if (!Array.isArray(e.advice)) p.push(`${where}.advice: must be an array`);
    else
      e.advice.forEach((a: unknown, i) => {
        const at = `${where}.advice[${i}]`;
        if (!isRecord(a)) return void p.push(`${at}: must be an object`);
        p.push(...unknownKeys(a, ['advice', 'at', 'project'], at));
        if (!(ADVICE_IDS as readonly unknown[]).includes(a.advice)) p.push(`${at}.advice: ${JSON.stringify(a.advice)} is not an advice id (${ADVICE_IDS.join(', ')})`);
        for (const key of ['at', 'project'] as const) if (a[key] !== undefined && typeof a[key] !== 'string') p.push(`${at}.${key}: must be a string`);
      });
    if (hookStep || !args.includes('--json')) p.push(`${where}.advice: needs a command case with --json in args, because only the JSON report lists advice`);
  }
  if (e.message !== undefined && typeof e.message !== 'string') p.push(`${where}.message: must be a string`);
  if (e.message !== undefined && !hookStep && args.includes('--json')) p.push(`${where}.message: is the text output, so args must not hold --json`);
  for (const key of ['messageIncludes', 'stderrIncludes'] as const) {
    if (e[key] !== undefined && typeof e[key] !== 'string' && !isStringArray(e[key])) p.push(`${where}.${key}: must be a string or an array of strings`);
  }
  if (e.pending !== undefined) {
    if (!hookStep) p.push(`${where}.pending: only a hook step has a session pending list`);
    if (!Array.isArray(e.pending) || !e.pending.every(isRuleId)) p.push(`${where}.pending: must be an array of rule ids`);
  }
  if (e.decision !== undefined) {
    if (!hookStep) p.push(`${where}.decision: only a hook step has a decision`);
    if (!DECISIONS.includes(e.decision as string)) p.push(`${where}.decision: must be one of ${DECISIONS.join(', ')}`);
  }
  if (e.stdoutEmpty !== undefined && typeof e.stdoutEmpty !== 'boolean') p.push(`${where}.stdoutEmpty: must be a boolean`);
  if (e.idempotent !== undefined && typeof e.idempotent !== 'boolean') p.push(`${where}.idempotent: must be a boolean`);
  for (const key of ['filesExist', 'filesMissing'] as const) {
    if (e[key] !== undefined && !(Array.isArray(e[key]) && (e[key] as unknown[]).every(isSafePath))) p.push(`${where}.${key}: must be an array of relative paths with /`);
  }
  return p;
}

/** Every problem of a case: its case.json against the contract, and the folders it needs. Empty when the case is valid. */
function validateCase(raw: unknown, caseDir?: string): string[] {
  if (!isRecord(raw)) return ['case.json: must be a JSON object'];
  const p = unknownKeys(raw, TOP_KEYS, 'case.json');
  if (typeof raw.description !== 'string' || raw.description.trim() === '' || raw.description.includes('\n')) p.push('description: must be one non-empty line');
  if (raw.setup !== undefined && !(Array.isArray(raw.setup) && raw.setup.every((a) => isStringArray(a) && a.length > 0))) p.push('setup: must be an array of non-empty argument lists');
  if (raw.delete !== undefined && !(Array.isArray(raw.delete) && raw.delete.every(isSafePath))) p.push('delete: must be an array of relative paths with /');
  if (raw.claudeProjectDir !== undefined && raw.claudeProjectDir !== 'project' && raw.claudeProjectDir !== 'parent') p.push('claudeProjectDir: must be "project" or "parent"');

  if ('steps' in raw) {
    for (const key of ['args', 'stdin', 'expect']) if (key in raw) p.push(`${key}: a hook sequence has steps, so it takes no top-level "${key}"`);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) p.push('steps: must be a non-empty array');
    else
      raw.steps.forEach((step: unknown, i) => {
        const at = `steps[${i}]`;
        if (!isRecord(step)) return void p.push(`${at}: must be an object`);
        p.push(...unknownKeys(step, STEP_KEYS, at));
        if (!(HOOK_PHASES as readonly unknown[]).includes(step.hook)) p.push(`${at}.hook: ${JSON.stringify(step.hook)} is not a phase (${HOOK_PHASES.join(', ')})`);
        if (typeof step.event !== 'string' || !/^[a-z][a-z0-9-]*$/.test(step.event)) p.push(`${at}.event: must be the event name for buckets hook, such as "pre-tool-use"`);
        if (step.agent !== undefined && (typeof step.agent !== 'string' || step.agent === '')) p.push(`${at}.agent: must be a non-empty string`);
        if (step.files !== undefined) {
          if (!isRecord(step.files)) p.push(`${at}.files: must be an object of path to content or null`);
          else
            for (const [file, content] of Object.entries(step.files)) {
              if (!isSafePath(file)) p.push(`${at}.files: ${JSON.stringify(file)} must be a relative path with /`);
              if (content !== null && typeof content !== 'string') p.push(`${at}.files["${file}"]: must be a string or null`);
            }
        }
        if (!isRecord(step.payload)) p.push(`${at}.payload: must be an object`);
        p.push(...validateExpect(step.expect, `${at}.expect`, true, []));
      });
  } else {
    if (raw.args !== undefined && !isStringArray(raw.args)) p.push('args: must be an array of strings');
    if (raw.stdin !== undefined && raw.stdin !== null && !isRecord(raw.stdin)) p.push('stdin: must be an object or null');
    if (!('expect' in raw)) p.push('expect: a command case needs "expect" (or "steps" for a hook sequence)');
    else p.push(...validateExpect(raw.expect, 'expect', false, isStringArray(raw.args) ? raw.args : DEFAULT_ARGS));
  }

  if (caseDir !== undefined) {
    const project = path.join(caseDir, 'project');
    if (!existsSync(project) || !statSync(project).isDirectory()) p.push('project/: the folder is missing');
    const after = path.join(caseDir, 'after');
    if (existsSync(after) && !statSync(after).isDirectory()) p.push('after: must be a folder');
  }
  return p;
}

interface LoadedCase {
  name: string;
  dir: string;
  spec: CaseSpec;
}

function loadCase(name: string): LoadedCase {
  const dir = path.join(EXAMPLES_DIR, name);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, 'case.json'), 'utf8'));
  } catch (error) {
    throw new Error(`case ${name}: case.json is not readable JSON: ${(error as Error).message}`);
  }
  const problems = validateCase(raw, dir);
  if (problems.length > 0) throw new Error(`case ${name}: invalid case.json (format: cli/src/testing/case-format.ts)\n  ${problems.join('\n  ')}`);
  return { name, dir, spec: raw as CaseSpec };
}

/** Folders with a case.json, plus check-* and hook-* folders, so a case that lost its case.json fails instead of vanishing. */
function listCaseNames(): string[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(EXAMPLES_DIR, name, 'case.json')) || /^(check|hook)-/.test(name))
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// Running

class CaseFailure extends Error {}

/**
 * The environment of every child process. GIT_* variables would point git at the outer repository, and the CI ones
 * (CI, GITHUB_*, RUNNER_*) would turn on annotations, step summaries and other CI paths of the CLI, so a case would
 * behave differently in CI than locally. A case that needs one sets it in the env of its run.
 */
const CHILD_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GITHUB_|RUNNER_|CI$)/i.test(key))),
  // Neither git nor the config search of the CLI goes up into examples/.tmp/, so nothing above a run folder counts.
  GIT_CEILING_DIRECTORIES: path.join(EXAMPLES_DIR, '.tmp'),
};

function run(command: string, args: string[], cwd: string, options: { stdin?: string; env?: Record<string, string> } = {}): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd,
    env: { ...CHILD_ENV, ...options.env },
    input: options.stdin ?? '',
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
  });
}

function git(args: string[], cwd: string): void {
  const result = run('git', ['-c', 'user.name=battery', '-c', 'user.email=battery@example.invalid', '-c', 'core.autocrlf=false', ...args], cwd);
  if (result.status !== 0) throw new CaseFailure(`git ${args.join(' ')} failed: ${result.error?.message ?? ''}${result.stderr ?? ''}`);
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n... (${text.length - OUTPUT_LIMIT} more characters)` : text;
}

/** Replaces ${PROJECT} in every string. In a string that starts with it, the rest of the path gets native separators, as a harness sends. */
function substituteProject(value: unknown, projectDir: string): unknown {
  if (typeof value === 'string') {
    const placeholder = '${PROJECT}';
    if (value.startsWith(placeholder)) return projectDir + value.slice(placeholder.length).split('/').join(path.sep);
    return value.split(placeholder).join(projectDir);
  }
  if (Array.isArray(value)) return value.map((item) => substituteProject(item, projectDir));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteProject(item, projectDir)]));
  return value;
}

/**
 * Links each npm workspace package into node_modules/<name>, as npm install does, so package imports between workspaces
 * resolve. Supports exact folders and a trailing /* in the workspaces globs. A junction needs no rights on Windows.
 */
function linkWorkspaces(projectDir: string): void {
  const file = path.join(projectDir, 'package.json');
  if (!existsSync(file)) return;
  let workspaces: unknown;
  try {
    workspaces = (JSON.parse(readFileSync(file, 'utf8')) as { workspaces?: unknown }).workspaces;
  } catch {
    return; // a broken package.json is a case of its own
  }
  if (!isStringArray(workspaces)) return;
  for (const glob of workspaces) {
    const folders = glob.endsWith('/*')
      ? readdirSync(path.join(projectDir, glob.slice(0, -2)), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(projectDir, glob.slice(0, -2), e.name))
      : [path.join(projectDir, glob)];
    for (const folder of folders) {
      const pkg = path.join(folder, 'package.json');
      if (!existsSync(pkg)) continue;
      const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
      if (typeof name !== 'string') continue;
      const link = path.join(projectDir, 'node_modules', ...name.split('/'));
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(folder, link, 'junction');
    }
  }
}

/** Maps every file under dir, except .git, to the sha256 of its content, keyed by a /-separated relative path. */
function snapshotTree(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        result.set(`${relative}/`, 'dir');
        walk(full, relative);
      } else if (entry.isFile()) {
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

/** Partial deep match: every key in expected must match, extra keys are ignored, arrays must have the same length. */
function partialMatch(expected: unknown, actual: unknown, where = 'stdout'): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${where}: expected an array, got ${JSON.stringify(actual)}`];
    if (expected.length !== actual.length) return [`${where}: expected ${expected.length} items, got ${actual.length}`];
    return expected.flatMap((item, i) => partialMatch(item, actual[i], `${where}[${i}]`));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return [`${where}: expected an object, got ${JSON.stringify(actual)}`];
    return Object.entries(expected).flatMap(([key, item]) => partialMatch(item, actual[key], `${where}.${key}`));
  }
  return Object.is(expected, actual) ? [] : [`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

interface Located {
  rule: string;
  file: string;
  line?: number;
  project: string;
}

function locate(v: Violation): Located {
  try {
    return { rule: v.rule, project: v.project, ...violationLocation(v) };
  } catch {
    // A violation without the fields its rule needs still shows up in the diff.
    return { rule: String(v.rule), project: String(v.project), file: '(malformed violation)' };
  }
}

function matches(exp: ExpectedViolation, act: Located): boolean {
  return (
    exp.rule === act.rule &&
    (exp.file === undefined || (Array.isArray(exp.file) ? exp.file.includes(act.file) : exp.file === act.file)) &&
    (exp.line === undefined || exp.line === act.line) &&
    (exp.project === undefined || exp.project === act.project)
  );
}

function formatViolation(v: ExpectedViolation | Located): string {
  const project = v.project !== undefined && v.project !== '.' ? `${v.project}: ` : '';
  const file = v.file === undefined ? '(any file)' : Array.isArray(v.file) ? `one of [${v.file.join(', ')}]` : v.file;
  return `${v.rule}  ${project}${file}${v.line === undefined ? '' : `:${v.line}`}`;
}

/** Set comparison of advice, like compareViolations. */
function compareAdvice(expected: ExpectedAdvice[], actual: Advice[]): string[] {
  const located = actual.map((a) => ({ advice: String(a.advice), at: Array.isArray(a.at) ? formatConfigPath(a.at) : '(malformed advice)', project: String(a.project) }));
  const hit = (e: ExpectedAdvice, a: (typeof located)[number]) => e.advice === a.advice && (e.at === undefined || e.at === a.at) && (e.project === undefined || e.project === a.project);
  const show = (a: ExpectedAdvice) => `${a.advice}  ${a.project !== undefined && a.project !== '.' ? `${a.project}: ` : ''}${a.at ?? '(any path)'}`;
  const missing = expected.filter((e) => !located.some((a) => hit(e, a)));
  const unexpected = located.filter((a) => !expected.some((e) => hit(e, a)));
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing advice:\n${missing.map((a) => `    - ${show(a)}`).join('\n')}`);
  if (unexpected.length > 0) problems.push(`unexpected advice:\n${unexpected.map((a) => `    + ${show(a as ExpectedAdvice)}`).join('\n')}`);
  return problems;
}

/** Set comparison: every expected item must match an actual violation, and every actual violation an expected item. */
function compareViolations(expected: ExpectedViolation[], actual: Violation[]): string[] {
  const located = actual.map(locate);
  const missing = expected.filter((exp) => !located.some((act) => matches(exp, act)));
  const unexpected = located.filter((act) => !expected.some((exp) => matches(exp, act)));
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing violations:\n${missing.map((v) => `    - ${formatViolation(v)}`).join('\n')}`);
  if (unexpected.length > 0) problems.push(`unexpected violations:\n${unexpected.map((v) => `    + ${formatViolation(v)}`).join('\n')}`);
  return problems;
}

const MESSAGE_KEYS = [
  'additionalContext',
  'additional_context',
  'contextModification',
  'context',
  'permissionDecisionReason',
  'reason',
  'followup_message',
  'agent_message',
  'user_message',
  'errorMessage',
  'message',
  'systemMessage',
];

/** The first string under any of `keys`, searched in key order, at any depth. */
function findString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const item = stack.pop();
      if (isRecord(item)) {
        if (typeof item[key] === 'string') return item[key] as string;
        stack.push(...Object.values(item));
      } else if (Array.isArray(item)) stack.push(...item);
    }
  }
  return undefined;
}

/**
 * The answer of the plugin protocol (cli/src/hooks/plugin-protocol.ts), which OpenCode, Pi and Amp plugins read: one
 * object with a `kind` that is a decision and an optional `text`. Undefined for any other output.
 */
function pluginAnswer(json: unknown): { kind: string; text: string } | undefined {
  if (!isRecord(json) || !DECISIONS.includes(json.kind as string)) return undefined;
  return { kind: json.kind as string, text: typeof json.text === 'string' ? json.text : '' };
}

/**
 * The text a reader gets. For `check`, stdout. For a hook, the context, deny or block text: the first of MESSAGE_KEYS in
 * the JSON on stdout, else the plain stdout, else stderr when the hook exits with 2 (a block in some harnesses).
 */
function readerMessage(hook: boolean, stdout: string, stderr: string, exitCode: number | null, json: unknown): string {
  if (!hook) return stdout;
  const plugin = pluginAnswer(json);
  if (plugin !== undefined) return plugin.text;
  if (json !== undefined) return findString(json, MESSAGE_KEYS) ?? '';
  if (stdout.trim() !== '') return stdout;
  return exitCode === 2 ? stderr : '';
}

/** Every value under `key` in a JSON value, at any depth. */
function valuesOf(value: unknown, key: string): unknown[] {
  const found: unknown[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (isRecord(item)) {
      if (key in item) found.push(item[key]);
      stack.push(...Object.values(item));
    } else if (Array.isArray(item)) stack.push(...item);
  }
  return found;
}

const DECISION_KEYS = ['permissionDecision', 'permission', 'decision'];

/** Why the stdout JSON approves the call, or undefined. An approval skips the user's permission prompt. */
function approval(json: unknown): string | undefined {
  for (const key of DECISION_KEYS) {
    const value = valuesOf(json, key).find((v) => v === 'allow' || v === 'approve');
    if (value !== undefined) return `"${key}": ${JSON.stringify(value)}`;
  }
  return valuesOf(json, 'continue').includes(true) ? '"continue": true' : undefined;
}

/**
 * The decision a hook's output carries. A plugin protocol answer carries it in `kind`. Otherwise a deny in the JSON
 * (a `deny` value or Cline's `cancel: true`) or a block (`decision: "block"` or a `followup_message`) comes first,
 * then exit code 2. Otherwise a message is a block in the stop phases, where it keeps the turn going, and context
 * elsewhere. No message is silent.
 */
function observedDecision(phase: string, message: string, exitCode: number | null, json: unknown): string {
  const stopPhase = phase === 'stop' || phase === 'subagent-stop';
  const plugin = pluginAnswer(json);
  if (plugin !== undefined) return plugin.kind;
  if (DECISION_KEYS.some((key) => valuesOf(json, key).includes('deny')) || valuesOf(json, 'cancel').includes(true)) return 'deny';
  if (valuesOf(json, 'decision').includes('block') || valuesOf(json, 'followup_message').some((v) => typeof v === 'string')) return 'block';
  if (exitCode === 2) return stopPhase ? 'block' : 'deny';
  if (message === '') return 'silent';
  return stopPhase ? 'block' : 'context';
}

const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\s+$/, '');

/**
 * The pending list of the step's session: .buckets/sessions/<session_id>[-<agent_id>].json, or the newest state file.
 * A missing file is an empty list.
 */
function readPending(sessionRoot: string, payload: Record<string, unknown>): { pending: Violation[]; file: string } | string {
  const dir = path.join(sessionRoot, ...SESSIONS_DIR.split('/'));
  let file: string | null = null;
  if (typeof payload.session_id === 'string') {
    const relative = sessionFile(payload.session_id, typeof payload.agent_id === 'string' ? payload.agent_id : null);
    if (relative === null) return `session_id ${JSON.stringify(payload.session_id)} cannot name a state file`;
    file = path.join(sessionRoot, ...relative.split('/'));
  } else if (existsSync(dir)) {
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    file = newest ?? null;
  }
  // No state file means the hook remembers nothing for the session, so its pending list is empty.
  if (file === null || !existsSync(file)) return { pending: [], file: file ?? `(no state file in ${dir})` };
  try {
    return { pending: parseSessionState(JSON.parse(readFileSync(file, 'utf8'))).pending, file };
  } catch (error) {
    return `session state ${file} is not JSON: ${(error as Error).message}`;
  }
}

interface Context {
  projectDir: string;
  sessionRoot: string;
}

function runCli(args: string[], ctx: Context, stdin: string): SpawnSyncReturns<string> {
  return run(process.execPath, [CLI_PATH, ...args], ctx.projectDir, {
    stdin,
    env: { CLAUDE_PROJECT_DIR: ctx.sessionRoot, NO_COLOR: '1', FORCE_COLOR: '0', SLOPBUCKETS_NO_UPDATE_CHECK: '1' },
  });
}

function prepare(loaded: LoadedCase, ctx: Context): void {
  rmSync(path.dirname(ctx.projectDir), { recursive: true, force: true });
  cpSync(path.join(loaded.dir, 'project'), ctx.projectDir, { recursive: true });
  linkWorkspaces(ctx.projectDir);
  git(['init', '-q'], ctx.projectDir);
  git(['add', '-A'], ctx.projectDir);
  git(['commit', '-q', '--allow-empty', '-m', 'case'], ctx.projectDir);
  for (const args of loaded.spec.setup ?? []) {
    const result = runCli(args, ctx, '');
    if (result.status !== 0) throw new CaseFailure(`setup "buckets ${args.join(' ')}" exited with ${result.status}:\n${truncate(`${result.stdout ?? ''}${result.stderr ?? ''}`)}`);
  }
  const after = path.join(loaded.dir, 'after');
  if (existsSync(after)) cpSync(after, ctx.projectDir, { recursive: true, force: true });
  for (const item of loaded.spec.delete ?? []) {
    const target = path.join(ctx.projectDir, item);
    if (!existsSync(target)) throw new CaseFailure(`"delete" entry ${item} does not exist in the prepared project`);
    rmSync(target, { recursive: true, force: true });
  }
}

/** Runs one CLI call and returns every mismatch with its expect, with the output appended when there is one. */
function runAndCompare(args: string[], stdinValue: unknown, expectation: CaseExpect, ctx: Context, hook: { phase: string; payload: Record<string, unknown> } | null): string[] {
  const stdin = stdinValue == null ? '' : JSON.stringify(substituteProject(stdinValue, ctx.projectDir));
  const result = runCli(args, ctx, stdin);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = result.status;
  const failures: string[] = [];
  if (result.error) failures.push(`the process failed to run: ${result.error.message}`);
  if (result.signal) failures.push(`the process was killed by ${result.signal}`);

  if (expectation.exitCode === 'nonzero') {
    if (exitCode === 0) failures.push('exit code: expected non-zero, got 0');
  } else if (expectation.exitCode !== undefined && exitCode !== expectation.exitCode) {
    failures.push(`exit code: expected ${expectation.exitCode}, got ${exitCode}`);
  }

  const checkJson = hook === null && args[0] === 'check' && args.includes('--json');
  let json: unknown;
  if (stdout.trim() !== '') {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = undefined;
    }
  }
  const needsJson = checkJson || expectation.stdoutJson !== undefined || (hook === null && expectation.violations !== undefined);
  if (needsJson && json === undefined) failures.push('stdout is not valid JSON');

  if (checkJson && json !== undefined) {
    // `check --json` prints the CheckResult of the engine contract.
    const report = json as Record<string, unknown>;
    if (report.exitCode !== exitCode) failures.push(`report.exitCode is ${JSON.stringify(report.exitCode)}, but the process exited with ${exitCode}`);
    for (const key of ['violations', 'environment', 'projects']) if (!Array.isArray(report[key])) failures.push(`report.${key} is not an array`);
    if (expectation.violations !== undefined && Array.isArray(report.violations)) failures.push(...compareViolations(expectation.violations, report.violations as Violation[]));
    if (expectation.advice !== undefined) {
      if (!Array.isArray(report.advice)) failures.push('report.advice is not an array');
      else failures.push(...compareAdvice(expectation.advice, report.advice as Advice[]));
    }
  }
  if (expectation.stdoutJson !== undefined && json !== undefined) failures.push(...partialMatch(expectation.stdoutJson, json));

  const message = normalize(readerMessage(hook !== null, stdout, stderr, exitCode, json));
  if (expectation.message !== undefined && message !== normalize(expectation.message)) {
    failures.push(`message differs:\n--- expected\n${normalize(expectation.message)}\n--- actual\n${message || '(empty)'}\n---`);
  }
  if (hook !== null) {
    const approved = json === undefined ? undefined : approval(json);
    if (approved !== undefined) failures.push(`stdout approves the call with ${approved}; a hook must never send an approval`);
    const decision = observedDecision(hook.phase, message, exitCode, json);
    if (expectation.decision !== undefined && decision !== expectation.decision) failures.push(`decision: expected ${expectation.decision}, got ${decision}`);
  }
  const includes = typeof expectation.messageIncludes === 'string' ? [expectation.messageIncludes] : (expectation.messageIncludes ?? []);
  for (const text of includes) if (!message.includes(text)) failures.push(`message does not include ${JSON.stringify(text)}`);

  if (hook !== null && (expectation.pending !== undefined || expectation.violations !== undefined)) {
    const state = readPending(ctx.sessionRoot, hook.payload);
    if (typeof state === 'string') failures.push(`pending: ${state}`);
    else {
      if (expectation.pending !== undefined) {
        const want = [...expectation.pending].sort();
        const got = state.pending.map((v) => String(v.rule)).sort();
        if (JSON.stringify(want) !== JSON.stringify(got)) failures.push(`pending: expected [${want.join(', ')}], got [${got.join(', ')}] (${state.file})`);
      }
      // In a hook step, violations are matched against the session's pending list.
      if (expectation.violations !== undefined) failures.push(...compareViolations(expectation.violations, state.pending));
    }
  }

  if (expectation.stdoutEmpty === true && stdout.trim() !== '') failures.push('stdout: expected no output');
  if (expectation.stdoutEmpty === false && stdout.trim() === '') failures.push('stdout: expected some output');
  const stderrExpected = typeof expectation.stderrIncludes === 'string' ? [expectation.stderrIncludes] : (expectation.stderrIncludes ?? []);
  for (const text of stderrExpected) if (!stderr.includes(text)) failures.push(`stderr does not include ${JSON.stringify(text)}`);
  for (const file of expectation.filesExist ?? []) if (!existsSync(path.join(ctx.projectDir, file))) failures.push(`expected ${file} to exist`);
  for (const file of expectation.filesMissing ?? []) if (existsSync(path.join(ctx.projectDir, file))) failures.push(`expected ${file} not to exist`);

  if (expectation.idempotent === true && failures.length === 0) {
    const first = snapshotTree(ctx.projectDir);
    const second = runCli(args, ctx, stdin);
    if (second.status !== exitCode) failures.push(`second run: exit code ${second.status}, the first run exited with ${exitCode}`);
    const changes = diffSnapshots(first, snapshotTree(ctx.projectDir));
    if (changes.length > 0) failures.push(`second run changed the project:\n    ${changes.join('\n    ')}`);
  }

  if (failures.length === 0) return [];
  const shownStdout = json !== undefined ? JSON.stringify(json, null, 2) : stdout;
  return [
    ...failures,
    '',
    `exit code: ${exitCode}`,
    `stdout:\n${truncate(shownStdout) || '(empty)'}`,
    `stderr:\n${truncate(stderr) || '(empty)'}`,
  ];
}

async function runCase(loaded: LoadedCase, runDir: string): Promise<void> {
  const { spec, name } = loaded;
  const projectDir = path.join(runDir, name, 'project');
  const ctx: Context = { projectDir, sessionRoot: spec.claudeProjectDir === 'parent' ? path.dirname(projectDir) : projectDir };
  const header = `case ${name}: ${spec.description}\n  project: ${projectDir}`;
  if (!existsSync(CLI_PATH)) throw new Error(`${header}\n\ncli/dist/index.js not found. Run "npm run build" first.`);

  try {
    prepare(loaded, ctx);
  } catch (error) {
    if (error instanceof CaseFailure) throw new Error(`${header}\n\nsetup failed: ${error.message}`);
    throw error;
  }

  if (!isHookSequence(spec)) {
    const args = spec.args ?? DEFAULT_ARGS;
    const failures = runAndCompare(args, spec.stdin, spec.expect, ctx, null);
    if (failures.length > 0) throw new Error([header, `  command: buckets ${args.join(' ')}`, '', 'mismatches:', ...failures.map((f) => `  ${f}`)].join('\n'));
    return;
  }

  for (const [i, step] of spec.steps.entries()) {
    for (const [file, content] of Object.entries(step.files ?? {})) {
      const target = path.join(projectDir, file);
      if (content === null) rmSync(target, { recursive: true, force: true });
      else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    const args = ['hook', '--agent', step.agent ?? 'claude', step.event];
    const payload = substituteProject(step.payload, projectDir) as Record<string, unknown>;
    const failures = runAndCompare(args, step.payload, step.expect, ctx, { phase: step.hook, payload });
    if (failures.length > 0) {
      throw new Error([header, `  step ${i + 1} of ${spec.steps.length}: buckets ${args.join(' ')}`, '', 'mismatches:', ...failures.map((f) => `  ${f}`)].join('\n'));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests

const caseNames = listCaseNames();

/**
 * Registers the tests of one shard of the battery: the cases whose place in the sorted list is `shard` modulo `count`,
 * in a run folder of their own. Shard 0 also checks the case files.
 */
export function battery(shard: number, count: number): void {
  const runDir = path.join(EXAMPLES_DIR, '.tmp', `${process.pid}-${Date.now().toString(36)}-${shard}`);
  const names = caseNames.filter((_, i) => i % count === shard);
  let failed = false;
  if (shard === 0) caseFiles();

  describe(`examples battery, shard ${shard + 1} of ${count}`, () => {
    afterAll(() => {
      if (failed) {
        console.error(`examples battery: kept ${runDir} for inspection`);
        return;
      }
      // Retries cover Windows, where a process that just exited can hold a handle for a moment.
      rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    for (const name of names) {
      let runs = 2;
      try {
        const spec = loadCase(name).spec;
        runs = (spec.setup?.length ?? 0) + (isHookSequence(spec) ? spec.steps.length * 2 : 2);
      } catch {
        // the case files test reports it
      }
      test(
        name,
        async () => {
          try {
            await runCase(loadCase(name), runDir);
          } catch (error) {
            failed = true;
            throw error;
          }
        },
        runs * RUN_TIMEOUT_MS + 10_000,
      );
    }
  });
}

function caseFiles(): void {
  describe('case files', () => {
    test('there is at least one case', () => {
      expect(caseNames.length).toBeGreaterThan(0);
    });

    for (const name of caseNames) {
      test(`${name} follows the contract format`, () => {
        loadCase(name);
      });
    }

    test('a malformed case fails with every problem named', () => {
      const problems = validateCase({ description: '', args: '--json', expect: { exitCode: 'one', violations: [{ rule: 'no-such-rule', line: 0 }], pending: [] }, lock: 'fresh' });
      expect(problems).toEqual([
        'case.json: unknown field "lock"',
        'description: must be one non-empty line',
        'args: must be an array of strings',
        'expect.exitCode: must be an integer or "nonzero"',
        `expect.violations[0].rule: "no-such-rule" is not a rule id (${RULE_IDS.join(', ')})`,
        'expect.violations[0].line: must be a positive integer',
        'expect.pending: only a hook step has a session pending list',
      ]);
      expect(validateCase({ description: 'x', steps: [{ hook: 'pre-write', payload: {}, expect: {} }], expect: {} })).toEqual([
        'expect: a hook sequence has steps, so it takes no top-level "expect"',
        'steps[0].hook: "pre-write" is not a phase (pre-edit, pre-tool, stop, subagent-stop, post-compact)',
        'steps[0].event: must be the event name for buckets hook, such as "pre-tool-use"',
      ]);
    });
  });
}

// Case format shared by the examples battery (battery.test.ts) and the fixture
// sanity test (fixtures.test.ts). The format is defined in SPEC.md, section
// "Bateria de exemplos". Extensions to that format are marked below and
// documented in examples/README.md.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLES_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.dirname(EXAMPLES_DIR);
export const TMP_DIR = path.join(EXAMPLES_DIR, '.tmp');

/**
 * A scratch folder for one test run, examples/.tmp/<prefix>-<pid>-<time>/. Every run gets its own folder, so two runs
 * at the same time (two terminals, an editor and a terminal) never delete or overwrite each other's copies.
 */
export function runDir(prefix: string): string {
  return path.join(TMP_DIR, `${prefix}-${process.pid}-${Date.now()}`);
}

export const RULE_IDS = [
  'config-invalid',
  'project-config',
  'folder-loose-file',
  'folder-max-depth',
  'folder-missing-code',
  'folder-unexpected-dmz',
  'folder-invalid-name',
  'folder-symlink',
  'dmz-path',
  'dmz-syntax',
  'dmz-target',
  'dmz-orphan',
  'import-relative',
  'import-dynamic',
  'import-unresolved',
  'import-forbidden',
  'import-namespace-dmz',
  'import-undeclared-package',
  'import-global',
  'graph-cycle',
  'access-denied',
  'access-unknown-bucket',
  'project-misplaced',
  'link-missing',
  'link-forbidden-import',
  'link-missing-dependency',
] as const;

export const LOCK_CHANGE_KINDS = [
  'lock-missing',
  'bucket-added',
  'bucket-removed',
  'config-changed',
  'dmz-added',
  'dmz-removed',
  'dmz-changed',
  'symbol-added',
  'symbol-removed',
  'signature-changed',
  'project-added',
  'project-removed',
  'link-added',
  'link-removed',
  'link-changed',
  'link-drift',
] as const;

export const ENVIRONMENT_CODES = [
  'no-config',
  'cli-version',
  'adapter-version',
  'no-typescript',
  'no-tsconfig',
  'adapter-failed',
] as const;

export type RuleId = (typeof RULE_IDS)[number];
export type LockChangeKind = (typeof LOCK_CHANGE_KINDS)[number];

export interface ExpectedViolation {
  rule: RuleId;
  /** Extension: an array lists acceptable alternatives, for rules such as graph-cycle where the spec lets the CLI pick one of several files. */
  file: string | string[];
  line?: number;
  /** Extension: the project of the violation (`.` or a nested project path), compared only when given. */
  project?: string;
}

export interface ExpectedLockChange {
  kind: LockChangeKind;
  path: string;
  symbol?: string;
  /** Extension: the project of the lock change, compared only when given. */
  project?: string;
}

export interface CaseExpect {
  /** Extension: "nonzero" accepts any exit code other than 0. */
  exitCode: number | 'nonzero';
  violations?: ExpectedViolation[];
  lockChanges?: ExpectedLockChange[];
  stdoutJson?: unknown;
  stdoutEmpty?: boolean;
  stderrIncludes?: string | string[];
  filesExist?: string[];
  filesMissing?: string[];
  /** Extension: run the command a second time and require the same exit code and an unchanged project tree. */
  idempotent?: boolean;
}

export interface CaseSpec {
  description: string;
  lock: 'fresh' | 'none' | 'file';
  /** Extension: fields shallow-merged into the computed lock before it is written. Only with lock "fresh". */
  lockPatch?: Record<string, unknown>;
  delete?: string[];
  /** Extension: CLI commands run in the project copy before the lock is computed, such as ["link", "update"]. Each must exit with 0. */
  setup?: string[][];
  args?: string[];
  /** Strings may contain ${PROJECT}, replaced by the absolute path of the temporary project. */
  stdin?: Record<string, unknown> | null;
  /** Extension: "parent" sets CLAUDE_PROJECT_DIR to the folder above the project copy, a session opened above the project. */
  claudeProjectDir?: 'project' | 'parent';
  expect: CaseExpect;
}

export interface LoadedCase {
  name: string;
  dir: string;
  projectDir: string;
  afterDir: string | null;
  raw: unknown;
  spec: CaseSpec;
}

export const DEFAULT_ARGS = ['check', '--json'];

const CASE_KEYS = new Set(['description', 'lock', 'lockPatch', 'delete', 'setup', 'args', 'stdin', 'claudeProjectDir', 'expect']);
const EXPECT_KEYS = new Set([
  'exitCode',
  'violations',
  'lockChanges',
  'stdoutJson',
  'stdoutEmpty',
  'stderrIncludes',
  'filesExist',
  'filesMissing',
  'idempotent',
]);

/** Lists the case folders, sorted by name. A case folder is any direct child of examples/ that has a case.json. */
export function listCaseNames(): string[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .filter((entry) => existsSync(path.join(EXAMPLES_DIR, entry.name, 'case.json')))
    .map((entry) => entry.name)
    .sort();
}

/** Reads a case without validating it. Throws when case.json is not valid JSON. */
export function loadCase(name: string): LoadedCase {
  const dir = path.join(EXAMPLES_DIR, name);
  const raw: unknown = JSON.parse(readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const afterDir = path.join(dir, 'after');
  return {
    name,
    dir,
    projectDir: path.join(dir, 'project'),
    afterDir: existsSync(afterDir) ? afterDir : null,
    raw,
    spec: raw as CaseSpec,
  };
}

export function caseArgs(spec: CaseSpec): string[] {
  return spec.args ?? DEFAULT_ARGS;
}

export function isCheckJson(args: string[]): boolean {
  return args[0] === 'check' && args.includes('--json');
}

export function isFileCheck(args: string[]): boolean {
  return args[0] === 'check' && args.includes('--file');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isProjectPath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !path.isAbsolute(value) && !value.split('/').includes('..');
}

/**
 * Validates a case against the format. Returns a list of problems, empty when the case is valid.
 * Checks the shape of case.json, the rule ids and lock change kinds, the required project files,
 * and that the expected exit code agrees with the expected violations and lock changes.
 */
export function validateCase(loaded: LoadedCase): string[] {
  const problems: string[] = [];
  const raw = loaded.raw;
  if (!isObject(raw)) return ['case.json must be a JSON object'];

  for (const key of Object.keys(raw)) {
    if (!CASE_KEYS.has(key)) problems.push(`unknown field "${key}"`);
  }
  if (typeof raw.description !== 'string' || raw.description.trim() === '') problems.push('"description" must be a non-empty string');
  if (raw.lock !== 'fresh' && raw.lock !== 'none' && raw.lock !== 'file') problems.push('"lock" must be "fresh", "none" or "file"');
  if (raw.lockPatch !== undefined) {
    if (!isObject(raw.lockPatch)) problems.push('"lockPatch" must be an object');
    if (raw.lock !== 'fresh') problems.push('"lockPatch" needs "lock": "fresh"');
  }
  if (raw.delete !== undefined) {
    if (!isStringArray(raw.delete)) problems.push('"delete" must be an array of strings');
    else {
      for (const item of raw.delete) {
        if (!isProjectPath(item)) problems.push(`"delete" entry "${item}" must be a relative path with "/" separators`);
        const inProject = existsSync(path.join(loaded.projectDir, item));
        const inAfter = loaded.afterDir !== null && existsSync(path.join(loaded.afterDir, item));
        if (!inProject && !inAfter) problems.push(`"delete" entry "${item}" does not exist in project/ or after/`);
      }
    }
  }
  if (raw.args !== undefined && (!isStringArray(raw.args) || raw.args.length === 0)) problems.push('"args" must be a non-empty array of strings');
  if (raw.setup !== undefined && (!Array.isArray(raw.setup) || !raw.setup.every((item) => isStringArray(item) && item.length > 0))) {
    problems.push('"setup" must be an array of non-empty arrays of strings');
  }
  if (raw.stdin !== undefined && raw.stdin !== null && !isObject(raw.stdin)) problems.push('"stdin" must be an object or null');
  if (raw.claudeProjectDir !== undefined && raw.claudeProjectDir !== 'project' && raw.claudeProjectDir !== 'parent') {
    problems.push('"claudeProjectDir" must be "project" or "parent"');
  }

  const expectValue = raw.expect;
  if (!isObject(expectValue)) {
    problems.push('"expect" must be an object');
    return problems;
  }
  for (const key of Object.keys(expectValue)) {
    if (!EXPECT_KEYS.has(key)) problems.push(`unknown field "expect.${key}"`);
  }
  const exitCode = expectValue.exitCode;
  if (!(exitCode === 'nonzero' || (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0))) {
    problems.push('"expect.exitCode" must be a non-negative integer or "nonzero"');
  }

  const violations = expectValue.violations;
  if (violations !== undefined) {
    if (!Array.isArray(violations)) problems.push('"expect.violations" must be an array');
    else {
      violations.forEach((item: unknown, index) => {
        const where = `expect.violations[${index}]`;
        if (!isObject(item)) return problems.push(`${where} must be an object`);
        for (const key of Object.keys(item)) {
          if (!['rule', 'file', 'line', 'project'].includes(key)) problems.push(`${where} has unknown field "${key}"`);
        }
        if (!(RULE_IDS as readonly unknown[]).includes(item.rule)) problems.push(`${where}.rule "${String(item.rule)}" is not a RuleId from SPEC.md`);
        const files = typeof item.file === 'string' ? [item.file] : item.file;
        if (!isStringArray(files) || files.length === 0) problems.push(`${where}.file must be a string or a non-empty array of strings`);
        else for (const file of files) if (!isProjectPath(file)) problems.push(`${where}.file "${file}" must be relative with "/" separators`);
        if (item.line !== undefined && !(typeof item.line === 'number' && Number.isInteger(item.line) && item.line >= 1)) {
          problems.push(`${where}.line must be an integer >= 1`);
        }
        return undefined;
      });
    }
  }

  const lockChanges = expectValue.lockChanges;
  if (lockChanges !== undefined) {
    if (!Array.isArray(lockChanges)) problems.push('"expect.lockChanges" must be an array');
    else {
      lockChanges.forEach((item: unknown, index) => {
        const where = `expect.lockChanges[${index}]`;
        if (!isObject(item)) return problems.push(`${where} must be an object`);
        for (const key of Object.keys(item)) {
          if (!['kind', 'path', 'symbol', 'project'].includes(key)) problems.push(`${where} has unknown field "${key}"`);

        }
        if (!(LOCK_CHANGE_KINDS as readonly unknown[]).includes(item.kind)) problems.push(`${where}.kind "${String(item.kind)}" is not a LockChangeKind from SPEC.md`);
        if (typeof item.path !== 'string' || !isProjectPath(item.path)) problems.push(`${where}.path must be relative with "/" separators`);
        if (item.symbol !== undefined && typeof item.symbol !== 'string') problems.push(`${where}.symbol must be a string`);
        return undefined;
      });
    }
  }

  if (expectValue.stdoutEmpty !== undefined && typeof expectValue.stdoutEmpty !== 'boolean') problems.push('"expect.stdoutEmpty" must be a boolean');
  if (expectValue.idempotent !== undefined && typeof expectValue.idempotent !== 'boolean') problems.push('"expect.idempotent" must be a boolean');
  const stderrIncludes = expectValue.stderrIncludes;
  if (stderrIncludes !== undefined && typeof stderrIncludes !== 'string' && !isStringArray(stderrIncludes)) {
    problems.push('"expect.stderrIncludes" must be a string or an array of strings');
  }
  for (const key of ['filesExist', 'filesMissing'] as const) {
    const value = expectValue[key];
    if (value === undefined) continue;
    if (!isStringArray(value)) problems.push(`"expect.${key}" must be an array of strings`);
    else for (const file of value) if (!isProjectPath(file)) problems.push(`"expect.${key}" entry "${file}" must be relative with "/" separators`);
  }
  if (expectValue.stdoutEmpty === true && expectValue.stdoutJson !== undefined) problems.push('"expect.stdoutEmpty" and "expect.stdoutJson" exclude each other');

  const stdoutEnvironment = isObject(expectValue.stdoutJson) ? expectValue.stdoutJson.environment : undefined;
  if (isObject(stdoutEnvironment) && stdoutEnvironment.code !== undefined && !(ENVIRONMENT_CODES as readonly unknown[]).includes(stdoutEnvironment.code)) {
    problems.push(`"expect.stdoutJson.environment.code" "${String(stdoutEnvironment.code)}" is not an EnvironmentCode from SPEC.md`);
  }

  // The exit code must agree with the expected report (SPEC.md, "buckets check").
  const args = isStringArray(raw.args) ? raw.args : DEFAULT_ARGS;
  if (isCheckJson(args) && typeof exitCode === 'number') {
    if (exitCode > 3) problems.push('"buckets check" exits with 0, 1, 2 or 3');
    const violationCount = Array.isArray(violations) ? violations.length : undefined;
    const lockChangeCount = Array.isArray(lockChanges) ? lockChanges.length : undefined;
    if (violationCount !== undefined && violationCount > 0 && exitCode !== 1) problems.push('a check with violations must exit with 1');
    if (exitCode === 1 && violationCount === 0) problems.push('exit code 1 needs at least one expected violation');
    if (exitCode === 0 && (violationCount ?? 0) + (lockChangeCount ?? 0) > 0) problems.push('exit code 0 cannot have violations or lock changes');
    if (exitCode === 2 && lockChangeCount === 0) problems.push('exit code 2 needs at least one expected lock change');
    if (isFileCheck(args) && (lockChangeCount ?? 0) > 0) problems.push('"check --file" skips the lock, so it cannot expect lock changes');
    if (exitCode === 3 && !isObject(stdoutEnvironment)) problems.push('exit code 3 should assert "expect.stdoutJson.environment"');
  }

  // Required project files.
  if (!existsSync(loaded.projectDir) || !statSync(loaded.projectDir).isDirectory()) {
    problems.push('missing project/ folder');
    return problems;
  }
  const isInit = args[0] === 'init';
  const required = isInit ? ['package.json', 'tsconfig.json'] : ['buckets.config.json', 'tsconfig.json', 'package.json', 'root'];
  for (const file of required) {
    if (!existsSync(path.join(loaded.projectDir, file))) problems.push(`project/ is missing ${file}`);
  }
  for (const file of ['buckets.config.json', 'tsconfig.json', 'package.json']) {
    const full = path.join(loaded.projectDir, file);
    if (!existsSync(full)) continue;
    try {
      JSON.parse(readFileSync(full, 'utf8'));
    } catch (error) {
      problems.push(`project/${file} is not valid JSON: ${(error as Error).message}`);
    }
  }
  const hasLockFile = existsSync(path.join(loaded.projectDir, 'buckets.lock.json'));
  if (raw.lock === 'file' && !hasLockFile) problems.push('"lock": "file" needs project/buckets.lock.json');
  if (raw.lock !== 'file' && hasLockFile) problems.push('project/buckets.lock.json is only allowed with "lock": "file"');
  if (loaded.afterDir !== null && existsSync(path.join(loaded.afterDir, 'buckets.lock.json'))) problems.push('after/ must not contain buckets.lock.json');

  return problems;
}

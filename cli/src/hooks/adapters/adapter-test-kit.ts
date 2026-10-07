// Test helpers for the shell-command hook adapters: run an adapter on a payload, the expected reports of the core,
// and the install suite every adapter shares (fresh project, user hooks, second run, uninstall).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LOGGER_PROJECT, makeProject } from '../../testing/fixture.js';
import { approve, fakeIo, testContext } from '../../testing/harness.js';
import type { HookAdapter } from '../adapter.js';
import { CONFIG_DENY_REASON, LOCK_DENY_REASON, postEdit, stop } from '../core.js';
import { parseJson } from '../../core/json.js';
import { unwrapFailOpen } from './hook-kit.js';

export { LOCK_DENY_REASON };

/** A project whose root/_/main.ts has a relative import (a violation) and whose root/log/_/logger.ts is clean. */
export function violationProject(extra: Record<string, string> = {}): string {
  return makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\nexport const main = x;\n", ...extra });
}

/** A project that passes `buckets check`, lock included. */
export async function cleanProject(): Promise<string> {
  const dir = makeProject({ 'root/_/main.ts': 'export const main = 1;\n' });
  await approve(dir);
  return dir;
}

export function newSessionId(): string {
  return randomUUID();
}

export async function runAdapter(adapter: HookAdapter, event: string, stdin: unknown, dir: string, env: Record<string, string> = {}) {
  const io = fakeIo({ cwd: dir, stdin: typeof stdin === 'string' ? stdin : JSON.stringify(stdin), env });
  const code = await adapter.run(testContext(), io, event);
  return { code, out: io.out, err: io.err };
}

/** The post-edit report the core gives for these files of `dir`. */
export async function feedbackFor(dir: string, ...files: string[]): Promise<string> {
  const result = await postEdit(testContext(), { projectDir: dir, cwd: dir, paths: files.map((f) => path.join(dir, f)) });
  if (result.feedback === undefined) throw new Error('expected feedback');
  return result.feedback;
}

/** The stop report the core gives for `dir`. */
export async function stopReportFor(dir: string, subagent = false): Promise<string> {
  const result = await stop(testContext(), { projectDir: dir, cwd: dir, active: false, subagent });
  if (result.block === undefined) throw new Error('expected a stop block');
  return result.block;
}

export const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** Paths a lock write may take: the plain name, an absolute Windows path, a stream suffix and a trailing dot. */
export function lockNames(dir: string): string[] {
  return [
    'buckets.lock.json',
    path.join(dir, 'buckets.lock.json'),
    String.raw`C:\Users\dev\shop\buckets.lock.json`,
    'buckets.lock.json::$DATA',
    'BUCKETS.LOCK.JSON.',
    './root/../buckets.lock.json',
  ];
}

/** Paths a config write may take: the root config under several names and the config of a nested project. */
export function configNames(dir: string): string[] {
  return ['buckets.config.json', path.join(dir, 'buckets.config.json'), 'buckets.config.json::$DATA', 'BUCKETS.CONFIG.JSON.', 'root/log/_/engine/buckets.config.json'];
}

/** The expected answer to a config write: the expected lock answer with the config reason in place of the lock reason. */
export function asConfigDeny<T>(expected: T): T {
  const escaped = (text: string) => JSON.stringify(text).slice(1, -1);
  const swap = (value: unknown): unknown => {
    if (typeof value === 'string') return value.split(LOCK_DENY_REASON).join(CONFIG_DENY_REASON).split(escaped(LOCK_DENY_REASON)).join(escaped(CONFIG_DENY_REASON));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    return value;
  };
  return swap(expected) as T;
}

/**
 * Every guarded path a write may take, each with the rewrite of the expected lock answer: the lock names unchanged,
 * then the config names with `asConfigDeny`.
 */
export function guardedNames(dir: string): [string, <T>(expected: T) => T][] {
  return [...lockNames(dir).map((name): [string, <T>(expected: T) => T] => [name, (expected) => expected]), ...configNames(dir).map((name): [string, <T>(expected: T) => T] => [name, asConfigDeny])];
}

/** A patch text in the apply_patch format with CRLF or LF line ends. */
export function patch(lines: string[], crlf = false): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join(crlf ? '\r\n' : '\n');
}

export const REFRESH_DENIED = ['buckets refresh', 'npx slopbuckets refresh', 'buckets refresh --web --yes', 'buckets.cmd refresh'];
export const REFRESH_ALLOWED = ['buckets refresh --web', 'buckets refresh --web > refresh.log 2>&1 &', 'npx slopbuckets refresh --web 2>&1 | tee refresh.log'];

export interface InstallFixture {
  /** The config file, relative to the project. */
  file: string;
  /** A config file with the user's own hooks (and maybe comments) that install must keep. */
  userText: string;
  /** Checks on the freshly installed file, parsed. */
  fresh: (json: Record<string, unknown>) => void;
  /** True when uninstall on a fresh install deletes the file. */
  freshUninstallDeletes: boolean;
}

function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text, 'utf8');
}

/** One command per hook object in a config (`command`, or `bash` for Copilot), for "is our hook there" checks. */
export function commandsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(commandsIn);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = [record.command, record.bash].find((item): item is string => typeof item === 'string');
  return [...(own === undefined ? [] : [own]), ...Object.values(record).flatMap(commandsIn)];
}

/** The four install tests every adapter runs. */
export function installSuite(adapter: HookAdapter, fixture: InstallFixture): void {
  // A command inside a fail-open guard (Copilot) counts as the command it runs.
  const ours = (json: unknown) => commandsIn(json).map(unwrapFailOpen).filter((c) => c.startsWith(`buckets hook --agent ${adapter.name} `));

  it('installs into a fresh project, runs a second time without changes, and uninstalls', () => {
    const dir = makeProject({}, false);
    const first = adapter.install(dir, { skill: null });
    expect(first[0]).toMatchObject({ status: 'done' });
    expect(first.every((s) => s.status !== 'failed')).toBe(true);
    const text = read(dir, fixture.file);
    const json = parseJson(text) as Record<string, unknown>;
    fixture.fresh(json);
    expect(new Set(ours(json)).size).toBe(ours(json).length);
    for (const event of adapter.events) expect(ours(json)).toContain(`buckets hook --agent ${adapter.name} ${event}`);

    const second = adapter.install(dir, { skill: null });
    expect(second[0]).toMatchObject({ status: 'kept' });
    expect(second.some((s) => s.status === 'done')).toBe(false);
    expect(read(dir, fixture.file)).toBe(text);

    const removed = adapter.uninstall(dir);
    expect(removed[0]).toMatchObject({ status: 'done' });
    if (fixture.freshUninstallDeletes) expect(existsSync(path.join(dir, fixture.file))).toBe(false);
    else expect(ours(parseJson(read(dir, fixture.file)))).toEqual([]);
    expect(adapter.uninstall(dir)).toEqual(fixture.freshUninstallDeletes ? [] : [{ status: 'kept', text: `${fixture.file} has no slopbuckets hooks` }]);
  });

  it("keeps the user's hooks and comments, and uninstall gives back the user's config", () => {
    const dir = makeProject({}, false);
    write(dir, fixture.file, fixture.userText);
    const before = parseJson(fixture.userText.replace(/^\s*\/\/.*$/gm, ''));
    const comments = fixture.userText.match(/\/\/.*$/gm) ?? [];
    expect(adapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    const installed = read(dir, fixture.file);
    for (const comment of comments) expect(installed).toContain(comment);
    const json = parseJson(installed.replace(/^\s*\/\/.*$/gm, ''));
    for (const command of commandsIn(before)) expect(commandsIn(json)).toContain(command);
    expect(ours(json).length).toBe(adapter.events.length);

    expect(adapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
    expect(read(dir, fixture.file)).toBe(installed);

    expect(adapter.uninstall(dir)[0]).toMatchObject({ status: 'done' });
    const after = read(dir, fixture.file);
    for (const comment of comments) expect(after).toContain(comment);
    expect(parseJson(after.replace(/^\s*\/\/.*$/gm, ''))).toEqual(before);
  });

  it('refuses a config it cannot merge into, without changing it', () => {
    const dir = makeProject({}, false);
    write(dir, fixture.file, '[1, 2]\n');
    expect(adapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(read(dir, fixture.file)).toBe('[1, 2]\n');
  });

  it('uninstall does nothing without the file', () => {
    const dir = makeProject({}, false);
    expect(adapter.uninstall(dir)).toEqual([]);
  });
}

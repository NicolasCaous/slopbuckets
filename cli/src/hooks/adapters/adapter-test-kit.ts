// Test helpers for the shell-command hook adapters: run an adapter on a payload, and the install suite every adapter
// shares (fresh project, user hooks, second run).
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { HookCore } from '../../contract/hooks.js';
import { parseJson } from '../../files/json.js';
import { makeProject } from '../../testing/fixture.js';
import { fakeIo, testContext } from '../../testing/harness.js';
import type { HookAdapter, HookContext } from '../adapter.js';
import { unwrapFailOpen } from './json-install.js';
import { runJson } from './json-run.js';

export function newSessionId(): string {
  return randomUUID();
}

/** The core the next runAdapter calls hand to the adapter, set by fakeCore in ./json-test-kit.ts. Unset is the real core. */
export const testCore: { current?: HookCore } = {};

/** The test context, with the fake core when one is set. */
export function hookContext(): HookContext {
  return testCore.current === undefined ? testContext() : { ...testContext(), hookCore: testCore.current };
}

export async function runAdapter(adapter: HookAdapter, event: string, stdin: unknown, dir: string, env: Record<string, string> = {}) {
  const io = fakeIo({ cwd: dir, stdin: typeof stdin === 'string' ? stdin : JSON.stringify(stdin), env });
  const code = await runJson(hookContext(), io, adapter, event);
  return { code, out: io.out, err: io.err };
}

export const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A patch text in the apply_patch format with CRLF or LF line ends. */
export function patch(lines: string[], crlf = false): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join(crlf ? '\r\n' : '\n');
}

export interface InstallFixture {
  /** The config file, relative to the project. */
  file: string;
  /** A config file with the user's own hooks (and maybe comments) that install must keep. */
  userText: string;
  /** Checks on the freshly installed file, parsed. */
  fresh: (json: Record<string, unknown>) => void;
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

  it('installs into a fresh project and runs a second time without changes', () => {
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
  });

  it("keeps the user's hooks and comments", () => {
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
  });

  it('refuses a config it cannot merge into, without changing it', () => {
    const dir = makeProject({}, false);
    write(dir, fixture.file, '[1, 2]\n');
    expect(adapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(read(dir, fixture.file)).toBe('[1, 2]\n');
  });
}

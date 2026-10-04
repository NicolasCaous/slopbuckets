import { afterEach, describe, expect, it } from 'vitest';
import { readLock } from '../core/lock.js';
import { cleanupProjects, fileExists, LOGGER_PROJECT, makeProject, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { refreshCommand } from './refresh.js';

afterEach(cleanupProjects);

describe('buckets refresh', () => {
  it('refuses to run without a terminal', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir, interactive: false });
    expect(await refreshCommand(testContext(), io, [])).toBe(1);
    expect(io.err).toContain('interactive terminal');
    expect(fileExists(dir, 'buckets.lock.json')).toBe(false);
  });

  it('refuses while a rule is broken', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['y'] });
    expect(await refreshCommand(testContext(), io, [])).toBe(1);
    expect(io.err).toContain('import-relative');
    expect(io.questions).toEqual([]);
    expect(fileExists(dir, 'buckets.lock.json')).toBe(false);
  });

  it('shows the initial state and writes the lock on yes', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['y'] });
    expect(await refreshCommand(testContext(), io, [])).toBe(0);
    expect(io.out).toContain('root/dmz/log/billing.ts  (logger)');
    expect(io.questions).toEqual(['Approve and write buckets.lock.json? [y/N] ']);
    expect(readLock(dir).kind).toBe('ok');
  });

  it('writes nothing on no or an empty answer', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    for (const answer of ['n', '']) {
      const io = fakeIo({ cwd: dir, interactive: true, answers: [answer] });
      expect(await refreshCommand(testContext(), io, [])).toBe(1);
      expect(fileExists(dir, 'buckets.lock.json')).toBe(false);
    }
  });

  it('prints a readable diff of the changes', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    writeFile(dir, 'root/mail/_/m.ts', 'export const m = 1;\n');
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['yes'] });
    expect(await refreshCommand(testContext(), io, [])).toBe(0);
    expect(io.out).toContain('+ bucket created          root/mail');
    // Symbols line up in one column after the longest path.
    expect(io.out).toContain('~ signature changed       root/billing/dmz/.parent/invoices.ts  logger');
    expect(io.out).toContain('~ signature changed       root/dmz/log/billing.ts               logger');
    expect(io.out).toContain('1 added, 2 changed.');
  });

  it('says so when nothing changed', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const io = fakeIo({ cwd: dir, interactive: true });
    expect(await refreshCommand(testContext(), io, [])).toBe(0);
    expect(io.out).toContain('up to date');
    expect(io.questions).toEqual([]);
  });

  it('updates the versions recorded in the lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, { ...testContext(), cliVersion: '0.0.0' });
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['y'] });
    expect(await refreshCommand(testContext(), io, [])).toBe(0);
    expect(io.out).toContain('~ CLI version             0.0.0 -> 1.0.0');
    const lock = readLock(dir);
    expect(lock.kind === 'ok' && lock.lock.cli).toBe('1.0.0');
  });
});

describe('buckets refresh and the toolchain', () => {
  it('accepts a toolchain change and shows it like a version change', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, testContext({ toolchain: 'typescript@5.8.0' }));
    const ctx = testContext({ toolchain: 'typescript@5.9.3' });
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['y'] });
    expect(await refreshCommand(ctx, io, [])).toBe(0);
    expect(io.out).toContain('~ toolchain               typescript@5.8.0 -> typescript@5.9.3');
    const lock = readLock(dir);
    expect(lock.kind === 'ok' && lock.lock.adapter.toolchain).toBe('typescript@5.9.3');
  });

  it('shows an unknown toolchain from an older lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['n'] });
    expect(await refreshCommand(testContext({ toolchain: 'typescript@5.9.3' }), io, [])).toBe(1);
    expect(io.out).toContain('~ toolchain               unknown -> typescript@5.9.3');
  });

  it('lists the toolchain when it creates the lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['n'] });
    await refreshCommand(testContext({ toolchain: 'typescript@5.9.3' }), io, []);
    expect(io.out).toContain('CLI 1.0.0, adapter ts 1.0.0, typescript@5.9.3');
  });
});

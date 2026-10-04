import { linkSync, readdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject, readFile, removeFile, writeFile } from '../testing/fixture.js';
import { approve, checkProject, testContext } from '../testing/harness.js';
import { textHash } from './hash.js';
import { diffLocks, LockWriteError, readLock, serializeLock, writeLockFile } from './lock.js';
import type { Lock } from './types.js';

afterEach(cleanupProjects);

const lock: Lock = {
  lockVersion: 1,
  cli: '1.0.0',
  adapter: { name: 'ts', version: '1.0.0' },
  config: 'sha256:c',
  buckets: ['root', 'root/a'],
  dmz: { 'root/dmz/a/.self.ts': { text: 'sha256:t', symbols: { x: 'sha256:x' } } },
};

describe('lock file', () => {
  it('normalizes CRLF before hashing the text', () => {
    expect(textHash('a\r\nb\r\n')).toBe(textHash('a\nb\n'));
    expect(textHash('a\nb')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('ignores a leading byte order mark before hashing the text, and only a leading one', () => {
    expect(textHash('\ufeffa\nb\n')).toBe(textHash('a\nb\n'));
    expect(textHash('\ufeffa\r\nb\r\n')).toBe(textHash('a\nb\n'));
    expect(textHash('a\ufeff\nb\n')).not.toBe(textHash('a\nb\n'));
  });

  it('finds no difference when a DMZ file is saved again with a byte order mark', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'root/dmz/log/billing.ts', `\ufeff${readFile(dir, 'root/dmz/log/billing.ts')}`);
    const { report } = await checkProject(dir);
    expect(report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });

  it('serializes with sorted keys, 2 spaces and a trailing newline', () => {
    const text = serializeLock({ dmz: {}, buckets: ['root'], config: 'c', adapter: { version: '1', name: 'ts' }, cli: '1', lockVersion: 1 } as unknown as Lock);
    expect(text).toBe(
      '{\n  "adapter": {\n    "name": "ts",\n    "version": "1"\n  },\n  "buckets": [\n    "root"\n  ],\n  "cli": "1",\n  "config": "c",\n  "dmz": {},\n  "lockVersion": 1\n}\n',
    );
  });

  it('computes the lock of the SPEC example', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const computed = await approve(dir);
    expect(computed.buckets).toEqual(['root', 'root/billing', 'root/billing/invoices', 'root/billing/payments', 'root/log']);
    expect(Object.keys(computed.dmz)).toEqual(['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts']);
    expect(Object.keys(computed.dmz['root/dmz/log/billing.ts']!.symbols)).toEqual(['logger']);
    expect(computed.cli).toBe('1.0.0');
    expect(computed.adapter).toEqual({ name: 'ts', version: '1.0.0' });
    expect(readFile(dir, 'buckets.lock.json')).toBe(serializeLock(computed));
    // The same state gives a byte-identical lock.
    expect(serializeLock(await approve(dir))).toBe(serializeLock(computed));
  });

  it('gives the same text hash with CRLF files', async () => {
    const lf = await approve(makeProject(LOGGER_PROJECT));
    const crlf = Object.fromEntries(Object.entries(LOGGER_PROJECT).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]));
    const other = await approve(makeProject(crlf));
    expect(other.dmz).toEqual(lf.dmz);
  });

  it('reads a missing, broken or valid lock', () => {
    const dir = makeProject({});
    expect(readLock(dir).kind).toBe('missing');
    writeFile(dir, 'buckets.lock.json', '{ nope');
    expect(readLock(dir).kind).toBe('invalid');
    writeFile(dir, 'buckets.lock.json', serializeLock(lock));
    expect(readLock(dir)).toEqual({ kind: 'ok', lock });
  });
});

describe('diffLocks', () => {
  const kinds = (next: Lock): string[] => diffLocks(lock, next).map((c) => `${c.kind} ${c.path}${c.symbol ? ` ${c.symbol}` : ''}`);
  const dmz = lock.dmz['root/dmz/a/.self.ts']!;

  it('finds no change in the same lock', () => {
    expect(diffLocks(lock, structuredClone(lock))).toEqual([]);
  });

  it('reports every change kind', () => {
    expect(kinds({ ...lock, buckets: ['root', 'root/a', 'root/b'] })).toEqual(['bucket-added root/b']);
    expect(kinds({ ...lock, buckets: ['root'] })).toEqual(['bucket-removed root/a']);
    expect(kinds({ ...lock, config: 'sha256:other' })).toEqual(['config-changed buckets.config.json']);
    expect(kinds({ ...lock, dmz: { ...lock.dmz, 'root/dmz/.self/a.ts': { text: 't', symbols: {} } } })).toEqual(['dmz-added root/dmz/.self/a.ts']);
    expect(kinds({ ...lock, dmz: {} })).toEqual(['dmz-removed root/dmz/a/.self.ts']);
    expect(kinds({ ...lock, dmz: { 'root/dmz/a/.self.ts': { ...dmz, text: 'sha256:new' } } })).toEqual(['dmz-changed root/dmz/a/.self.ts']);
    expect(kinds({ ...lock, dmz: { 'root/dmz/a/.self.ts': { text: 'sha256:new', symbols: { x: 'sha256:x', y: 'sha256:y' } } } })).toEqual([
      'dmz-changed root/dmz/a/.self.ts',
      'symbol-added root/dmz/a/.self.ts y',
    ]);
    expect(kinds({ ...lock, dmz: { 'root/dmz/a/.self.ts': { text: 'sha256:new', symbols: {} } } })).toEqual([
      'dmz-changed root/dmz/a/.self.ts',
      'symbol-removed root/dmz/a/.self.ts x',
    ]);
    expect(kinds({ ...lock, dmz: { 'root/dmz/a/.self.ts': { ...dmz, symbols: { x: 'sha256:changed' } } } })).toEqual([
      'signature-changed root/dmz/a/.self.ts x',
    ]);
  });
});

describe('check against the lock', () => {
  it('reports lock-missing with exit 2 when the rules pass', async () => {
    const { report } = await checkProject(makeProject(LOGGER_PROJECT));
    expect(report.exitCode).toBe(2);
    expect(report.lockChanges.map((c) => `${c.kind} ${c.path}`)).toEqual(['lock-missing buckets.lock.json']);
  });

  it('passes with exit 0 right after approval', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    expect((await checkProject(dir)).report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });

  it('reports a new bucket and a new DMZ file with exit 2', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'root/mail/_/send.ts', "import { logger } from '@root/dmz/log/mail';\nlogger('x');\n");
    writeFile(dir, 'root/dmz/log/mail.ts', "export { logger } from '@root/log/_/logger';\n");
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(2);
    expect(report.lockChanges.map((c) => `${c.kind} ${c.path}`)).toEqual(['bucket-added root/mail', 'dmz-added root/dmz/log/mail.ts']);
  });

  it('reports a signature change made in _/ code without touching the DMZ', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    const { report } = await checkProject(dir);
    expect(report.lockChanges.map((c) => `${c.kind} ${c.path} ${c.symbol}`)).toEqual([
      'signature-changed root/billing/dmz/.parent/invoices.ts logger',
      'signature-changed root/dmz/log/billing.ts logger',
    ]);
  });

  it('reports deleted chains as removals', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'root/billing/invoices/_/create-invoice.ts', 'export const created = 1;\n');
    removeFile(dir, 'root/billing/dmz/.parent/invoices.ts');
    removeFile(dir, 'root/dmz/log/billing.ts');
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(2);
    expect(report.lockChanges.map((c) => c.kind)).toEqual(['dmz-removed', 'dmz-removed']);
  });

  it('reports a config change, but not a formatting change', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    writeFile(dir, 'buckets.config.json', '{\n  "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v1.json",\n  "root": "root",\n  "alias": "@root"\n}\n');
    expect((await checkProject(dir)).report.exitCode).toBe(0);
    writeFile(dir, 'buckets.config.json', '{ "root": "root", "maxDepth": 3 }');
    expect((await checkProject(dir)).report.lockChanges.map((c) => c.kind)).toEqual(['config-changed']);
  });

  it('refuses to run with exit 3 when the CLI version differs from the lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, { ...testContext(), cliVersion: '0.0.0' });
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(3);
    expect(report.environment?.code).toBe('cli-version');
    expect(report.environment?.message).toContain('slopbuckets@0.0.0');
  });

  it('names the lock format when the lock has a lockVersion this CLI cannot read, even with the same CLI version', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const lock = JSON.parse(readFile(dir, 'buckets.lock.json'));
    writeFile(dir, 'buckets.lock.json', `${JSON.stringify({ ...lock, lockVersion: 9 }, null, 2)}\n`);
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(3);
    expect(report.environment?.code).toBe('cli-version');
    expect(report.environment?.message).toContain('lockVersion 9');
    expect(report.environment?.message).not.toContain('but the installed CLI is 1.0.0. Install the matching version (npm install -g slopbuckets@1.0.0)');
  });

  it('refuses to run with exit 3 when the adapter version differs from the lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, testContext({ info: { version: '9.9.9' } }));
    const { report } = await checkProject(dir);
    expect(report.environment?.code).toBe('adapter-version');
  });

  it('skips the version check in check --file', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, { ...testContext(), cliVersion: '0.0.0' });
    const { report } = await checkProject(dir, { file: 'root/_/main.ts' });
    expect(report.exitCode).toBe(0);
  });

  it('treats an unreadable lock as missing', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.lock.json': 'garbage' });
    const { report } = await checkProject(dir);
    expect(report.exitCode).toBe(2);
    expect(report.lockChanges.map((c) => c.kind)).toEqual(['lock-missing']);
  });
});

describe('symbols named like Object.prototype members', () => {
  const NAMES = ['toString', 'constructor', '__proto__', 'hasOwnProperty'];
  const project = (names: string[]): Record<string, string> => ({
    ...LOGGER_PROJECT,
    'root/log/_/special.ts': names.map((n) => `export const ${n} = 1;`).join('\n') + '\n',
    'root/dmz/log/billing.ts': `export { logger } from '@root/log/_/logger';\n${names.length > 0 ? `export { ${names.join(', ')} } from '@root/log/_/special';\n` : ''}`,
    'root/billing/_/billing.module.ts':
      names.length > 0 ? `import { ${names.join(', ')} } from '@root/dmz/log/billing';\nexport const billing = [${names.join(', ')}];\n` : 'export const billing = 1;\n',
  });

  it('stores them as ordinary keys and reads them back', async () => {
    const dir = makeProject(project(NAMES));
    const computed = await approve(dir);
    const symbols = computed.dmz['root/dmz/log/billing.ts']!.symbols;
    expect(Object.keys(symbols).sort()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'logger', 'toString']);
    expect(readFile(dir, 'buckets.lock.json')).toContain('"__proto__": "sha256:');
    const read = readLock(dir);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(Object.keys(read.lock.dmz['root/dmz/log/billing.ts']!.symbols).sort()).toEqual(Object.keys(symbols).sort());
    expect((await checkProject(dir)).report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });

  it('reports them as added when they are new, not as changed signatures', async () => {
    const dir = makeProject(project([]));
    await approve(dir);
    for (const [file, content] of Object.entries(project(NAMES))) writeFile(dir, file, content);
    const { report } = await checkProject(dir);
    expect(report.lockChanges.map((c) => `${c.kind} ${c.symbol ?? c.path}`)).toEqual([
      'dmz-changed root/dmz/log/billing.ts',
      'symbol-added __proto__',
      'symbol-added constructor',
      'symbol-added hasOwnProperty',
      'symbol-added toString',
    ]);
  });

  it('reports them as removed when they go away', async () => {
    const dir = makeProject(project(NAMES));
    await approve(dir);
    for (const [file, content] of Object.entries(project([]))) writeFile(dir, file, content);
    const { report } = await checkProject(dir);
    expect(report.lockChanges.filter((c) => c.kind === 'symbol-removed').map((c) => c.symbol)).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  });

  it('does not read inherited members in diffLocks', () => {
    const before: Lock = JSON.parse(serializeLock(lock)) as Lock;
    const after: Lock = JSON.parse(serializeLock(lock)) as Lock;
    after.dmz['root/dmz/a/.self.ts']!.symbols = JSON.parse('{"x": "sha256:x", "toString": "sha256:t", "__proto__": "sha256:p"}') as Record<string, string>;
    expect(diffLocks(before, after).map((c) => `${c.kind} ${c.symbol}`)).toEqual(['symbol-added __proto__', 'symbol-added toString']);
    expect(diffLocks(after, before).map((c) => `${c.kind} ${c.symbol}`)).toEqual(['symbol-removed __proto__', 'symbol-removed toString']);
  });
});

describe('toolchain in the lock', () => {
  it('stores the toolchain next to the adapter version', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const computed = await approve(dir, testContext({ toolchain: 'typescript@5.9.3' }));
    expect(computed.adapter).toEqual({ name: 'ts', version: '1.0.0', toolchain: 'typescript@5.9.3' });
    expect(readFile(dir, 'buckets.lock.json')).toContain('"toolchain": "typescript@5.9.3"');
  });

  it('ignores a toolchain difference alone, such as a TypeScript patch release', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, testContext({ toolchain: 'typescript@5.9.2' }));
    const result = await checkProject(dir, {}, testContext({ toolchain: 'typescript@5.9.3' }));
    expect(result.report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
    // The computed lock carries the new toolchain, so `buckets refresh` still shows and stores it.
    expect(result.lock?.adapter.toolchain).toBe('typescript@5.9.3');
  });

  it('refuses to run with exit 3 (adapter-version) when the toolchain differs and a signature hash differs too', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, testContext({ toolchain: 'typescript@5.8.0' }));
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    const { report } = await checkProject(dir, {}, testContext({ toolchain: 'typescript@5.9.3' }));
    expect(report.exitCode).toBe(3);
    expect(report.environment?.code).toBe('adapter-version');
    expect(report.environment?.message).toContain('typescript@5.8.0');
    expect(report.environment?.message).toContain('typescript@5.9.3');
    expect(report.environment?.message).toContain('`logger` in root/dmz/log/billing.ts');
    expect(report.environment?.message).toContain('buckets refresh');
  });

  it('reports a signature change as a lock change when the toolchain is the same', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, testContext({ toolchain: 'typescript@5.9.3' }));
    writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
    const { report } = await checkProject(dir, {}, testContext({ toolchain: 'typescript@5.9.3' }));
    expect(report.exitCode).toBe(2);
    expect(report.lockChanges.map((c) => c.kind)).toContain('signature-changed');
  });

  it('treats a missing toolchain on either side as no difference', async () => {
    const old = makeProject(LOGGER_PROJECT);
    await approve(old);
    expect((await checkProject(old, {}, testContext({ toolchain: 'typescript@5.9.3' }))).report.exitCode).toBe(0);
    const newer = makeProject(LOGGER_PROJECT);
    await approve(newer, testContext({ toolchain: 'typescript@5.9.3' }));
    expect((await checkProject(newer)).report.exitCode).toBe(0);
  });

  it('ignores the toolchain in check --file and when versions are ignored', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir, testContext({ toolchain: 'typescript@5.8.0' }));
    const ctx = testContext({ toolchain: 'typescript@5.9.3' });
    expect((await checkProject(dir, { file: 'root/_/main.ts' }, ctx)).report.exitCode).toBe(0);
    const result = await checkProject(dir, { ignoreVersions: true }, ctx);
    expect(result.report.exitCode).toBe(0);
    expect(result.lock?.adapter.toolchain).toBe('typescript@5.9.3');
  });

  it('rejects a lock whose toolchain is not a string', () => {
    const dir = makeProject({});
    writeFile(dir, 'buckets.lock.json', serializeLock({ ...lock, adapter: { name: 'ts', version: '1.0.0', toolchain: 5 } } as unknown as Lock));
    expect(readLock(dir)).toEqual({ kind: 'invalid', reason: 'adapter.toolchain is malformed' });
  });
});

describe('writeLockFile', () => {
  it('writes through a temporary file and leaves no temporary file behind', async () => {
    const dir = makeProject({});
    await writeLockFile(dir, lock);
    expect(readFile(dir, 'buckets.lock.json')).toBe(serializeLock(lock));
    await writeLockFile(dir, { ...lock, cli: '0.0.2' });
    expect(readLock(dir)).toMatchObject({ kind: 'ok', lock: { cli: '0.0.2' } });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces a hard link instead of writing through it', async () => {
    const dir = makeProject({ 'elsewhere.json': 'keep' });
    linkSync(path.join(dir, 'elsewhere.json'), path.join(dir, 'buckets.lock.json'));
    await writeLockFile(dir, lock);
    expect(readFile(dir, 'elsewhere.json')).toBe('keep');
    expect(readFile(dir, 'buckets.lock.json')).toBe(serializeLock(lock));
  });

  it('refuses when buckets.lock.json is a folder or a link, with a clear error', async () => {
    const dir = makeProject({ 'buckets.lock.json/x': 'x' });
    await expect(writeLockFile(dir, lock)).rejects.toThrow(LockWriteError);
    await expect(writeLockFile(dir, lock)).rejects.toThrow('is a folder, so the lock was not written');
    const linked = makeProject({ 'target/keep.txt': 'keep' });
    symlinkSync(path.join(linked, 'target'), path.join(linked, 'buckets.lock.json'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeLockFile(linked, lock)).rejects.toThrow('is a symbolic link or junction');
    expect(readFile(linked, 'target/keep.txt')).toBe('keep');
    expect(readdirSync(linked).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { check, computeLock, writeLock } from './api.js';
import { main } from './cli.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, readFile } from './testing/fixture.js';
import { approve, fakeIo, testContext } from './testing/harness.js';

afterEach(cleanupProjects);

describe('buckets command line', () => {
  it('prints help and versions', async () => {
    const io = fakeIo({ cwd: '.' });
    expect(await main(testContext(), io, ['--help'])).toBe(0);
    expect(io.out).toContain('Usage: buckets');
    const version = fakeIo({ cwd: '.' });
    expect(await main(testContext(), version, ['--version'])).toBe(0);
    expect(version.out).toBe('buckets 1.0.0\nadapter ts 1.0.0 (protocol 1)\n');
  });

  it('rejects unknown commands and options', async () => {
    const io = fakeIo({ cwd: '.' });
    expect(await main(testContext(), io, ['nope'])).toBe(1);
    expect(io.err).toContain('unknown command');
    expect(await main(testContext(), io, ['check', '--bogus'])).toBe(1);
    expect(await main(testContext(), io, ['hook', 'nope'])).toBe(1);
  });

  it('check --json prints the CheckReport and exits with its code', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check', '--json'])).toBe(2);
    expect(JSON.parse(io.out)).toEqual({
      exitCode: 2,
      violations: [],
      lockChanges: [{ kind: 'lock-missing', path: 'buckets.lock.json', message: expect.any(String), project: '.' }],
      projects: [{ path: '.', exitCode: 2 }],
    });
  });

  it('check finds the project from a subfolder', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const io = fakeIo({ cwd: `${dir}/root/log/_` });
    expect(await main(testContext(), io, ['check'])).toBe(0);
    expect(io.out).toContain('All bucket rules pass');
  });

  it('check prints text grouped by file with the next step', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import a from './a';\nimport b from './b';\n" });
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['check'])).toBe(1);
    expect(io.out).toMatch(/^root\/_\/main\.ts\n  line 1  import-relative\n    Relative import .*\n  line 2  import-relative\n    Relative import /);
    expect(io.out).toContain('Exit code 1');
  });

  it('check --file resolves the path from the current folder', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import a from './a';\n", 'root/log/_/logger.ts': "import b from './b';\n" });
    const io = fakeIo({ cwd: `${dir}/root` });
    expect(await main(testContext(), io, ['check', '--json', '--file', '_/main.ts'])).toBe(1);
    const report = JSON.parse(io.out) as { violations: { file: string }[] };
    expect(report.violations.map((v) => v.file)).toEqual(['root/_/main.ts']);
  });
});

describe('programmatic API with an injected adapter', () => {
  it('computeLock and writeLock prepare a project that then passes check', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const ctx = testContext();
    const lock = await computeLock(dir, ctx);
    await writeLock(dir, lock);
    expect(readFile(dir, 'buckets.lock.json').endsWith('}\n')).toBe(true);
    expect(await check(dir, {}, ctx)).toEqual({ exitCode: 0, violations: [], lockChanges: [], projects: [{ path: '.', exitCode: 0 }] });

  });

  it('computeLock throws on an invalid config', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': '{ "nope": 1 }' });
    await expect(computeLock(dir, testContext())).rejects.toThrow(/Unknown field/);
  });

  it('uses the real adapter by default and reports its failures as exit 3', async () => {
    const report = await check(makeProject(LOGGER_PROJECT));
    expect(report.exitCode).toBe(3);
    expect(report.environment).toBeDefined();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { AdapterEnvironmentError } from '@slopbuckets/adapter-ts';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { approve, checkProject, pairs, testContext } from '../testing/harness.js';
import { exitCodeFor } from './check.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function caseInsensitiveFs(): boolean {
  return existsSync(fileURLToPath(import.meta.url).toUpperCase());
}

afterEach(cleanupProjects);

describe('exit codes', () => {
  const violation = { rule: 'import-relative' as const, file: 'a', message: 'm' };
  const change = { kind: 'bucket-added' as const, path: 'b', message: 'm' };

  it('applies 3 over 1 over 2 over 0', () => {
    expect(exitCodeFor({ violations: [], lockChanges: [] })).toBe(0);
    expect(exitCodeFor({ violations: [], lockChanges: [change] })).toBe(2);
    expect(exitCodeFor({ violations: [violation], lockChanges: [] })).toBe(1);
    expect(exitCodeFor({ violations: [violation], lockChanges: [change] })).toBe(1);
    expect(exitCodeFor({ violations: [violation], lockChanges: [change], environment: { code: 'adapter-failed', message: 'x' } })).toBe(3);
  });

  it('exits 1 and still lists lock changes when rules are broken and the state differs from the lock', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const broken = makeProject({ ...LOGGER_PROJECT, 'root/billing/payments/_/pay.ts': "import { x } from './x';\n", 'root/notes/_/n.ts': '' });
    const { report } = await checkProject(broken);
    expect(report.exitCode).toBe(1);
    expect(report.lockChanges.map((c) => c.kind)).toEqual(['lock-missing']);
    const { report: withLock } = await checkProject(dir);
    expect(withLock.exitCode).toBe(0);
  });
});

describe('adapter results', () => {
  it('sends one analyze request with the collected files', async () => {
    const ctx = testContext();
    await checkProject(makeProject({ ...LOGGER_PROJECT, 'root/_/style.css': '' }), {}, ctx);
    expect(ctx.adapter.analyzeCalls).toHaveLength(1);
    expect(ctx.adapter.analyzeCalls[0]).toEqual({
      abi: 1,
      config: { root: 'root', alias: '@root' },
      files: {
        dmz: ['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts'],
        code: [
          'root/_/main.ts',
          'root/billing/_/billing.module.ts',
          'root/billing/invoices/_/create-invoice.ts',
          'root/billing/payments/_/pay.ts',
          'root/log/_/logger.ts',
        ],
      },
    });
  });

  it('maps analyze.config to project-config', async () => {
    const ctx = testContext({ projectConfig: [{ file: 'tsconfig.json', message: 'noUnusedLocals is off' }] });
    const { report } = await checkProject(makeProject(LOGGER_PROJECT), {}, ctx);
    expect(pairs(report.violations)).toEqual(['project-config tsconfig.json']);
    expect(report.violations[0]!.message).toContain('noUnusedLocals is off.');
    expect(report.exitCode).toBe(1);
  });

  it('maps DMZ violations from the adapter to dmz-syntax', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/dmz/log/billing.ts': "export { logger } from '@root/log/_/logger';\nexport const x = 1;\n" });
    const { report } = await checkProject(dir);
    expect(report.violations.map((v) => `${v.rule} ${v.file} ${v.line}`)).toEqual(['dmz-syntax root/dmz/log/billing.ts 2']);
  });

  it.each(['no-typescript', 'no-tsconfig', 'adapter-failed'] as const)('maps AdapterEnvironmentError %s to exit 3', async (code) => {
    const ctx = testContext({ analyzeError: new AdapterEnvironmentError(code, `problem ${code}`) });
    const { report } = await checkProject(makeProject(LOGGER_PROJECT), {}, ctx);
    expect(report).toEqual({ exitCode: 3, violations: [], lockChanges: [], environment: { code, message: `problem ${code}` } });
  });

  it('maps an unexpected adapter exception to adapter-failed', async () => {
    const ctx = testContext({ analyzeError: new TypeError('boom') });
    const { report } = await checkProject(makeProject(LOGGER_PROJECT), {}, ctx);
    expect(report.exitCode).toBe(3);
    expect(report.environment?.code).toBe('adapter-failed');
    expect(report.environment?.message).toContain('boom');
  });

  it('refuses an adapter with another protocol version', async () => {
    const ctx = testContext({ info: { abi: 2 } });
    const { report } = await checkProject(makeProject(LOGGER_PROJECT), {}, ctx);
    expect(report.environment?.code).toBe('adapter-failed');
  });
});

describe('check --file', () => {
  it('accepts absolute paths and returns only that file', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/billing/payments/_/pay.ts': "import { x } from './x';\n", 'root/_/main.ts': "import y from './y';\n" });
    const { report } = await checkProject(dir, { file: `${dir}/root/_/main.ts` });
    expect(pairs(report.violations)).toEqual(['import-relative root/_/main.ts']);
  });

  it('reports the layout violation of the folder that holds the file', async () => {
    const config = JSON.stringify({ root: 'root', layout: { default: 'deny', allow: ['root/*'], deny: ['root/legacy'] } });
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': config, 'root/legacy/_/old.ts': 'export const old = 1;\n', 'root/legacy/deep/_/d.ts': 'export const d = 1;\n' });
    for (const file of ['root/legacy/_/old.ts', 'root/legacy/deep/_/d.ts', 'root/billing/invoices/_/create-invoice.ts']) {
      const { report } = await checkProject(dir, { file });
      expect(report.exitCode, file).toBe(1);
      expect(pairs(report.violations), file).toEqual([file.startsWith('root/legacy') ? 'layout-denied root/legacy' : 'layout-denied root/billing/invoices']);
    }
    // A file next to the folder, or in a folder whose name only starts the same way, stays clean.
    const clean = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': config, 'root/legacy/_/old.ts': '', 'root/legacy2/_/n.ts': 'export const n = 1;\n' });
    expect((await checkProject(clean, { file: 'root/legacy2/_/n.ts' })).report.violations).toEqual([]);
    expect((await checkProject(clean, { file: 'root/_/main.ts' })).report.violations).toEqual([]);
  });

  it('reports a layout-ambiguous folder on the files inside it', async () => {
    const config = JSON.stringify({ root: 'root', layout: { default: 'deny', allow: ['root/*', 'root/le*'], deny: ['root/*y'] } });
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': config, 'root/legacy/_/old.ts': 'export const old = 1;\n' });
    expect(pairs((await checkProject(dir, { file: 'root/legacy/_/old.ts' })).report.violations)).toEqual(['layout-ambiguous root/legacy']);
  });

  // On Windows and macOS the file system ignores case, so a path typed with other case names the same file.
  it.skipIf(!caseInsensitiveFs())('finds the file when the path differs from the disk only in case', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import y from './y';\n" });
    for (const file of ['ROOT/_/main.ts', 'root/_/MAIN.TS', `${dir}/Root/_/Main.ts`]) {
      const { report } = await checkProject(dir, { file });
      expect(pairs(report.violations), file).toEqual(['import-relative root/_/main.ts']);
    }
  });
});

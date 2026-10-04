import { afterEach, describe, expect, it } from 'vitest';
import { formatReport } from '../../output/text.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../../testing/fixture.js';
import { checkProject, testContext } from '../../testing/harness.js';

afterEach(cleanupProjects);

function orphanFiles(violations: { rule: string; file: string }[]): string[] {
  return violations.filter((v) => v.rule === 'dmz-orphan').map((v) => v.file).sort();
}

describe('orphan contracts', () => {
  it('accepts contracts that reach an import', async () => {
    const { report } = await checkProject(makeProject(LOGGER_PROJECT));
    expect(report.violations).toEqual([]);
  });

  it('reports the whole unused chain in one run, from origin to tip', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/billing/invoices/_/create-invoice.ts': 'export const created = 1;\n' });
    const result = await checkProject(dir);
    expect(orphanFiles(result.report.violations)).toEqual(['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts']);
    expect(result.orphanChains).toEqual([
      { symbol: 'logger', origin: 'root/log', files: ['root/dmz/log/billing.ts', 'root/billing/dmz/.parent/invoices.ts'] },
    ]);
    const message = result.report.violations.find((v) => v.file === 'root/dmz/log/billing.ts')!.message;
    expect(message).toContain('root/dmz/log/billing.ts -> root/billing/dmz/.parent/invoices.ts');
    expect(formatReport(result.report, result.orphanChains)).toContain(
      'dmz-orphan  logger  (origin root/log)\n    root/dmz/log/billing.ts               line 1\n    root/billing/dmz/.parent/invoices.ts  line 1\n',
    );
  });

  it('keeps the shared link when another consumer still uses it', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/billing/invoices/_/create-invoice.ts': 'export const created = 1;\n',
      'root/billing/_/billing.module.ts': "import { logger } from '@root/dmz/log/billing';\nlogger('x');\n",
    });
    const { report } = await checkProject(dir);
    expect(orphanFiles(report.violations)).toEqual(['root/billing/dmz/.parent/invoices.ts']);
  });

  it('reports one symbol of a file while the other is used', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/log/_/level.ts': 'export const level = 1;\n',
      'root/dmz/log/billing.ts': "export { logger } from '@root/log/_/logger';\nexport { level } from '@root/log/_/level';\n",
    });
    const { report } = await checkProject(dir);
    const orphans = report.violations.filter((v) => v.rule === 'dmz-orphan');
    expect(orphans.map((v) => [v.file, v.line])).toEqual([['root/dmz/log/billing.ts', 2]]);
  });

  it('reports an empty DMZ file', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/dmz/log/.self.ts': '// nothing\n' });
    const { report } = await checkProject(dir);
    expect(orphanFiles(report.violations)).toEqual(['root/dmz/log/.self.ts']);
  });

  it('does not tell the agent to delete a DMZ file whose only re-export breaks the DMZ syntax', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/dmz/log/billing.ts': "export { logger as log } from '@root/log/_/logger';\n" });
    const { report } = await checkProject(dir);
    const empty = report.violations.find((v) => v.rule === 'dmz-orphan' && v.file === 'root/dmz/log/billing.ts')!;
    expect(empty.message).not.toContain('Delete the file');
    expect(empty.message).toContain('dmz-syntax');
  });

  it('does not run in check --file', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/billing/invoices/_/create-invoice.ts': 'export const created = 1;\n' });
    const { report } = await checkProject(dir, { file: 'root/dmz/log/billing.ts' });
    expect(report.violations).toEqual([]);
  });

  it('does not count a forbidden import as a use', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/billing/invoices/_/create-invoice.ts': 'export const created = 1;\n',
      'root/billing/payments/_/pay.ts': "import { logger } from '@root/billing/dmz/.parent/invoices';\nlogger('x');\n",
    });
    const { report } = await checkProject(dir);
    expect(orphanFiles(report.violations)).toEqual(['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts']);
    expect(report.violations.some((v) => v.rule === 'import-forbidden' && v.file === 'root/billing/payments/_/pay.ts')).toBe(true);
  });
});

describe('uses that do not count for the orphan rule', () => {
  const CHAIN = ['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts'];

  it('does not count a re-export from _/ code as a use, and reports the whole chain', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/billing/invoices/_/create-invoice.ts': "export { logger } from '@root/billing/dmz/.parent/invoices';\n" });
    const result = await checkProject(dir);
    expect(orphanFiles(result.report.violations)).toEqual(CHAIN);
    expect(result.orphanChains.map((c) => c.files)).toEqual([['root/dmz/log/billing.ts', 'root/billing/dmz/.parent/invoices.ts']]);
  });

  it('does not count imported names the file never references', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/billing/invoices/_/create-invoice.ts': "import { logger } from '@root/billing/dmz/.parent/invoices';\nexport const created = 1;\n",
    });
    const { report } = await checkProject(dir, {}, testContext({ reportUnused: true }));
    expect(orphanFiles(report.violations)).toEqual(CHAIN);
  });

  it('counts the referenced names of an import that also has unused ones', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/log/_/logger.ts': 'export function logger(message: string): void {}\nexport const level = 1;\n',
      'root/dmz/log/billing.ts': "export { logger, level } from '@root/log/_/logger';\n",
      'root/billing/dmz/.parent/invoices.ts': "export { logger, level } from '@root/dmz/log/billing';\n",
      'root/billing/invoices/_/create-invoice.ts': "import { logger, level } from '@root/billing/dmz/.parent/invoices';\nlogger('created');\n",
    });
    const result = await checkProject(dir, {}, testContext({ reportUnused: true }));
    expect(orphanFiles(result.report.violations)).toEqual(CHAIN);
    expect(result.report.violations.every((v) => v.message.includes('`level`'))).toBe(true);
  });

  it('counts every name when the adapter does not report unusedNames', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/billing/invoices/_/create-invoice.ts': "import { logger } from '@root/billing/dmz/.parent/invoices';\nexport const created = 1;\n",
    });
    expect((await checkProject(dir)).report.violations).toEqual([]);
  });

  it('still uses a laundered import for the bucket graph', async () => {
    const dir = makeProject({
      'root/_/main.ts': 'export const main = 1;\n',
      'root/a/_/a.ts': "export { b } from '@root/dmz/b/a';\nexport const a = 1;\n",
      'root/b/_/b.ts': "import { a } from '@root/dmz/a/b';\nexport const b = a;\n",
      'root/dmz/a/b.ts': "export { a } from '@root/a/_/a';\n",
      'root/dmz/b/a.ts': "export { b } from '@root/b/_/b';\n",
    });
    const { report } = await checkProject(dir);
    expect(report.violations.filter((v) => v.rule === 'graph-cycle').map((v) => v.file).sort()).toEqual(['root/a/_/a.ts', 'root/b/_/b.ts']);
    expect(orphanFiles(report.violations)).toEqual(['root/dmz/b/a.ts']);
  });
});

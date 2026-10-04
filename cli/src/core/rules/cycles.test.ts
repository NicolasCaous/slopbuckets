import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../../testing/fixture.js';
import { checkProject } from '../../testing/harness.js';
import { cyclicComponents } from './cycles.js';

afterEach(cleanupProjects);

const SIBLING_CYCLE: Record<string, string> = {
  'root/_/main.ts': 'export const main = 1;\n',
  'root/a/_/a.ts': "import { b } from '@root/dmz/b/a';\nexport const a = b;\n",
  'root/b/_/b.ts': "import { a } from '@root/dmz/a/b';\nexport const b = a;\n",
  'root/dmz/a/b.ts': "export { a } from '@root/a/_/a';\n",
  'root/dmz/b/a.ts': "export { b } from '@root/b/_/b';\n",
};

const SELF_CYCLE: Record<string, string> = {
  'root/_/main.ts': 'export const main = 1;\n',
  'root/billing/_/m.ts': "import { inv } from '@root/billing/dmz/invoices/.self';\nexport const mod = inv;\n",
  'root/billing/invoices/_/i.ts': "import { mod } from '@root/billing/dmz/.self/invoices';\nexport const inv = mod;\n",
  'root/billing/dmz/invoices/.self.ts': "export { inv } from '@root/billing/invoices/_/i';\n",
  'root/billing/dmz/.self/invoices.ts': "export { mod } from '@root/billing/_/m';\n",
};

function cycleFiles(violations: { rule: string; file: string }[]): string[] {
  return violations.filter((v) => v.rule === 'graph-cycle').map((v) => v.file).sort();
}

describe('bucket graph cycles', () => {
  it('finds strongly connected components', () => {
    const adjacency = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set(['a'])],
    ]);
    expect(cyclicComponents(['a', 'b', 'c', 'd'], adjacency)).toEqual([['a', 'b', 'c']]);
  });

  it('reports a cycle between siblings on every file that adds a cycle edge', async () => {
    const { report } = await checkProject(makeProject(SIBLING_CYCLE));
    expect(report.exitCode).toBe(1);
    expect(cycleFiles(report.violations)).toEqual(['root/a/_/a.ts', 'root/b/_/b.ts']);
    const a = report.violations.find((v) => v.rule === 'graph-cycle' && v.file === 'root/a/_/a.ts')!;
    expect(a.line).toBe(1);
    expect(a.message).toContain('root/a -> root/b -> root/a');
  });

  it('reports a cycle through .self contracts', async () => {
    const { report } = await checkProject(makeProject(SELF_CYCLE));
    expect(cycleFiles(report.violations)).toEqual(['root/billing/_/m.ts', 'root/billing/invoices/_/i.ts']);
    expect(report.violations.find((v) => v.rule === 'graph-cycle')!.message).toMatch(/root\/billing -> root\/billing\/invoices -> root\/billing|root\/billing\/invoices -> root\/billing -> root\/billing\/invoices/);
  });

  it('follows re-export chains to the origin bucket (SPEC example with logger)', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/billing/invoices/_/invoice.ts': 'export const inv = 1;\n',
      'root/billing/dmz/invoices/.parent.ts': "export { inv } from '@root/billing/invoices/_/invoice';\n",
      'root/dmz/billing/log.ts': "export { inv } from '@root/billing/dmz/invoices/.parent';\n",
      'root/log/_/logger.ts': "import { inv } from '@root/dmz/billing/log';\nexport function logger(message: string): void {}\n",
    });
    const { report } = await checkProject(dir);
    expect(cycleFiles(report.violations)).toEqual(['root/billing/invoices/_/create-invoice.ts', 'root/log/_/logger.ts']);
    expect(report.violations.find((v) => v.file === 'root/log/_/logger.ts')!.message).toContain('root/log -> root/billing/invoices -> root/log');
  });

  it('accepts a one-way graph', async () => {
    const { report } = await checkProject(makeProject(LOGGER_PROJECT));
    expect(cycleFiles(report.violations)).toEqual([]);
  });

  it('check --file reports the cycles the file takes part in, and nothing about other files', async () => {
    const dir = makeProject(SIBLING_CYCLE);
    const { report } = await checkProject(dir, { file: 'root/a/_/a.ts' });
    expect(report.violations.map((v) => `${v.rule} ${v.file}`)).toEqual(['graph-cycle root/a/_/a.ts']);
    expect(report.lockChanges).toEqual([]);
    expect(report.exitCode).toBe(1);
    const other = await checkProject(dir, { file: 'root/_/main.ts' });
    expect(other.report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });
});

describe('check --file on a DMZ file', () => {
  // invoices -> log through root/billing/dmz/.parent/invoices.ts and root/dmz/log/billing.ts,
  // and log -> invoices through root/dmz/billing/log.ts and root/billing/dmz/invoices/.parent.ts.
  const CHAIN_CYCLE: Record<string, string> = {
    ...LOGGER_PROJECT,
    'root/billing/invoices/_/create-invoice.ts': "import { logger } from '@root/billing/dmz/.parent/invoices';\nexport function created(): void {\n  logger('created');\n}\n",
    'root/billing/dmz/invoices/.parent.ts': "export { created } from '@root/billing/invoices/_/create-invoice';\n",
    'root/dmz/billing/log.ts': "export { created } from '@root/billing/dmz/invoices/.parent';\n",
    'root/log/_/logger.ts': "import { created } from '@root/dmz/billing/log';\nexport function logger(message: string): void {\n  created();\n}\n",
  };

  it('reports the cycle closed by the re-export in the DMZ file itself', async () => {
    const dir = makeProject(SIBLING_CYCLE);
    const { report } = await checkProject(dir, { file: 'root/dmz/a/b.ts' });
    expect(report.violations.map((v) => `${v.rule} ${v.file} ${v.line}`)).toEqual(['graph-cycle root/dmz/a/b.ts 1']);
    expect(report.violations[0]!.message).toContain('root/b -> root/a -> root/b');
    expect(report.violations[0]!.message).toContain('re-exports `a`');
    expect(report.exitCode).toBe(1);
  });

  it('reports the cycle on every DMZ file of the re-export chain', async () => {
    const dir = makeProject(CHAIN_CYCLE);
    const full = await checkProject(dir);
    expect(cycleFiles(full.report.violations)).toEqual(['root/billing/invoices/_/create-invoice.ts', 'root/log/_/logger.ts']);
    for (const file of ['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts', 'root/dmz/billing/log.ts', 'root/billing/dmz/invoices/.parent.ts']) {
      const { report } = await checkProject(dir, { file });
      expect(cycleFiles(report.violations), file).toEqual([file]);
    }
  });

  it('reports nothing for a DMZ file outside the cycle', async () => {
    const dir = makeProject({
      ...SIBLING_CYCLE,
      'root/c/_/c.ts': "import { a } from '@root/dmz/a/c';\nexport const c = a;\n",
      'root/dmz/a/c.ts': "export { a } from '@root/a/_/a';\n",
    });
    const { report } = await checkProject(dir, { file: 'root/dmz/a/c.ts' });
    expect(report.violations).toEqual([]);
  });
});

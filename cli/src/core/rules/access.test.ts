import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../../testing/fixture.js';
import { checkProject } from '../../testing/harness.js';
import type { Violation } from '../types.js';

afterEach(cleanupProjects);

function config(access: Record<string, unknown>): string {
  return `${JSON.stringify({ root: 'root', access }, null, 2)}\n`;
}

/** LOGGER_PROJECT with an access key: invoices imports `logger` from log through two DMZ files. */
function loggerProject(access: Record<string, unknown>, extra: Record<string, string> = {}): string {
  return makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': config(access), ...extra });
}

function access(violations: Violation[]): Violation[] {
  return violations.filter((v) => v.rule.startsWith('access-'));
}

function where(violations: Violation[]): string[] {
  return access(violations).map((v) => `${v.rule} ${v.file}${v.line !== undefined ? `:${v.line}` : ''}`).sort();
}

const IMPORTER = 'root/billing/invoices/_/create-invoice.ts';

describe('access-denied on imports', () => {
  it('denies an import that no allow line matches under default deny, with the edge resolved to the origin', async () => {
    const { report } = await checkProject(loggerProject({ default: 'deny' }));
    expect(report.exitCode).toBe(1);
    expect(where(report.violations)).toEqual([
      'access-denied root/billing/dmz/.parent/invoices.ts:1',
      `access-denied ${IMPORTER}:1`,
      'access-denied root/dmz/log/billing.ts:1',
    ]);
    const message = report.violations.find((v) => v.file === IMPORTER)!.message;
    // The edge goes from the importing bucket to the bucket that declares the symbol, past the .parent DMZ file.
    expect(message).toContain('Access denied: root/billing/invoices -> root/log.');
    expect(message).toContain('imports `logger` (declared in root/log) from root/billing/dmz/.parent/invoices.ts');
    expect(message).toContain('No line in access.allow of buckets.config.json matches this edge, and access.default is "deny".');
    expect(message).toContain('The re-export chain is root/billing/dmz/.parent/invoices.ts -> root/dmz/log/billing.ts -> root/log/_/logger.ts.');
    expect(message).toContain('buckets.config.json belongs to a human');
    expect(message).toContain('ask the human to change "access"');
  });

  it('accepts an import that an allow line matches', async () => {
    const { report } = await checkProject(loggerProject({ default: 'deny', allow: ['root/billing/** -> root/log'] }));
    expect(access(report.violations)).toEqual([]);
  });

  it('lets a deny line win over a matching allow line', async () => {
    const { report } = await checkProject(loggerProject({ default: 'deny', allow: ['** -> root/log'], deny: ['root/billing/invoices -> root/log'] }));
    // root/dmz/log/billing.ts serves all of root/billing, and root/billing may still use root/log, so only the
    // importer and the DMZ file that serves invoices alone are reported.
    expect(where(report.violations)).toEqual(['access-denied root/billing/dmz/.parent/invoices.ts:1', `access-denied ${IMPORTER}:1`]);
    const message = report.violations.find((v) => v.file === IMPORTER)!.message;
    expect(message).toContain('The line "root/billing/invoices -> root/log" in access.deny of buckets.config.json matches this edge.');
  });

  it('denies only what a deny line matches under default allow', async () => {
    const dir = loggerProject(
      { default: 'allow', deny: ['root/billing/** -> root/log'] },
      { 'root/api/_/api.ts': "import { logger } from '@root/dmz/log/api';\nlogger('api');\n", 'root/dmz/log/api.ts': "export { logger } from '@root/log/_/logger';\n" },
    );
    const { report } = await checkProject(dir);
    expect(where(report.violations)).toEqual([
      'access-denied root/billing/dmz/.parent/invoices.ts:1',
      `access-denied ${IMPORTER}:1`,
      'access-denied root/dmz/log/billing.ts:1',
    ]);
    expect(report.violations.find((v) => v.file === IMPORTER)!.message).toContain('The line "root/billing/** -> root/log" in access.deny');
  });

  it('checks nothing when the config has no access key', async () => {
    const { report } = await checkProject(makeProject(LOGGER_PROJECT));
    expect(access(report.violations)).toEqual([]);
  });
});

describe('access-denied on DMZ files', () => {
  it('reports a re-export to a child consumer when every bucket of the child is denied', async () => {
    const dir = loggerProject({ default: 'deny', allow: ['root/billing/payments -> root/log'] });
    const { report } = await checkProject(dir);
    // root/dmz/log/billing.ts also serves root/billing/payments, which may use root/log.
    expect(where(report.violations)).toEqual(['access-denied root/billing/dmz/.parent/invoices.ts:1', `access-denied ${IMPORTER}:1`]);
    const message = report.violations.find((v) => v.file === 'root/billing/dmz/.parent/invoices.ts')!.message;
    expect(message).toContain('Access denied for every consumer of this DMZ file: it re-exports `logger` (declared in root/log), but its consumer root/billing/invoices may not use code from root/log.');
    expect(message).toContain('No line in access.allow of buckets.config.json matches root/billing/invoices -> root/log, and access.default is "deny".');
    expect(message).toContain('The re-export chain is root/billing/dmz/.parent/invoices.ts -> root/dmz/log/billing.ts -> root/log/_/logger.ts.');
    expect(message).toContain('Remove `logger` from this file');
  });

  it('names every bucket of the child subtree when all of them are denied', async () => {
    const { report } = await checkProject(loggerProject({ default: 'deny' }));
    const message = report.violations.find((v) => v.rule === 'access-denied' && v.file === 'root/dmz/log/billing.ts')!.message;
    expect(message).toContain('none of the buckets that may import it (root/billing, root/billing/invoices, root/billing/payments) may use code from root/log');
  });

  it('reports a .self re-export that its owner may not use, and skips a .parent re-export', async () => {
    const dir = makeProject({
      'buckets.config.json': config({ default: 'allow', deny: ['** -> root/billing/invoices'] }),
      'root/_/main.ts': 'export const main = 1;\n',
      'root/billing/_/billing.ts': 'export const billing = 1;\n',
      'root/billing/invoices/_/invoice.ts': 'export const inv = 1;\nexport const total = 2;\n',
      'root/billing/dmz/invoices/.self.ts': "export { inv } from '@root/billing/invoices/_/invoice';\n",
      'root/billing/dmz/invoices/.parent.ts': "export { total } from '@root/billing/invoices/_/invoice';\n",
    });
    const { report } = await checkProject(dir);
    expect(where(report.violations)).toEqual(['access-denied root/billing/dmz/invoices/.self.ts:1']);
    expect(report.violations.find((v) => v.rule === 'access-denied')!.message).toContain('but its consumer root/billing may not use code from root/billing/invoices');
  });
});

describe('access-unknown-bucket', () => {
  it('reports a side without wildcards that names no bucket', async () => {
    const { report } = await checkProject(loggerProject({ default: 'allow', deny: ['root/billing/invoice -> root/log'] }));
    expect(where(report.violations)).toEqual(['access-unknown-bucket buckets.config.json']);
    const message = report.violations.find((v) => v.rule === 'access-unknown-bucket')!.message;
    expect(message).toContain('The line "root/billing/invoice -> root/log" in access.deny names the bucket root/billing/invoice on its left side');
    expect(message).toContain('ask the human');
    expect(report.exitCode).toBe(1);
  });

  it('accepts patterns with wildcards that match nothing', async () => {
    const { report } = await checkProject(loggerProject({ default: 'deny', allow: ['root/billing/** -> root/log', 'root/gone/** -> root/log', 'root/x* -> root/{a,b}'] }));
    expect(access(report.violations)).toEqual([]);
  });
});

describe('access rules with check --file', () => {
  const ACCESS = { default: 'deny', allow: ['** -> root/log'], deny: ['root/billing/invoices -> root/log', 'root/missing -> root/log'] };

  it('reports the denied import of the file, and nothing about other files', async () => {
    const dir = loggerProject(ACCESS);
    const { report } = await checkProject(dir, { file: IMPORTER });
    expect(where(report.violations)).toEqual([`access-denied ${IMPORTER}:1`]);
    expect(report.exitCode).toBe(1);
    const other = await checkProject(dir, { file: 'root/_/main.ts' });
    expect(other.report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });

  it('reports a denied edge on every DMZ file of its chain', async () => {
    const dir = loggerProject(ACCESS);
    // The full check does not report root/dmz/log/billing.ts, because root/billing may still use root/log.
    const full = await checkProject(dir);
    expect(where(full.report.violations).filter((v) => v.includes('root/dmz/log/billing.ts'))).toEqual([]);
    const { report } = await checkProject(dir, { file: 'root/dmz/log/billing.ts' });
    expect(where(report.violations)).toEqual(['access-denied root/dmz/log/billing.ts:1']);
    expect(report.violations[0]!.message).toContain(`This DMZ file re-exports \`logger\` (declared in root/log), and ${IMPORTER} imports it from root/billing/dmz/.parent/invoices.ts`);
    // The early check already reports the other DMZ file, so the edge is not reported on it a second time.
    const parent = await checkProject(dir, { file: 'root/billing/dmz/.parent/invoices.ts' });
    expect(where(parent.report.violations)).toEqual(['access-denied root/billing/dmz/.parent/invoices.ts:1']);
    expect(parent.report.violations[0]!.message).toContain('Access denied for every consumer of this DMZ file');
  });

  it('reports unknown buckets on buckets.config.json', async () => {
    const { report } = await checkProject(loggerProject(ACCESS), { file: 'buckets.config.json' });
    expect(where(report.violations)).toEqual(['access-unknown-bucket buckets.config.json']);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { checkProject } from '../../testing/harness.js';

afterEach(cleanupProjects);

// root has children log and billing; billing has children invoices and payments; invoices has child pdf.
const BASE: Record<string, string> = {
  'buckets.config.json': '{ "root": "root", "maxDepth": 3 }',
  'root/_/main.ts': 'export const main = 1;\n',
  'root/log/_/logger.ts': 'export const logger = 1;\n',
  'root/billing/_/billing.module.ts': 'export const billingModule = 1;\n',
  'root/billing/invoices/_/invoice.ts': 'export const invoice = 1;\n',
  'root/billing/invoices/pdf/_/pdf.ts': 'export const pdf = 1;\n',
  'root/billing/payments/_/pay.ts': 'export const pay = 1;\n',
  'root/dmz/log/billing.ts': "export { logger } from '@root/log/_/logger';\n",
  'root/dmz/.self/billing.ts': "export { main } from '@root/_/main';\n",
  'root/billing/invoices/dmz/pdf/.parent.ts': "export { pdf } from '@root/billing/invoices/pdf/_/pdf';\n",
};

async function targetViolations(file: string, statement: string): Promise<string[]> {
  const dir = makeProject({ ...BASE, [file]: `${statement}\n` });
  const { report } = await checkProject(dir);
  expect(report.violations.filter((v) => v.rule === 'dmz-path' || v.rule === 'dmz-syntax')).toEqual([]);
  return report.violations.filter((v) => v.rule === 'dmz-target').map((v) => v.file);
}

describe('DMZ re-export targets (SPEC table)', () => {
  it.each([
    ['<child>/<consumer>.ts from the child code', 'root/billing/dmz/payments/invoices.ts', "export { pay } from '@root/billing/payments/_/pay';"],
    ['<child>/<consumer>.ts from a .parent.ts of the child', 'root/billing/dmz/invoices/payments.ts', "export { pdf } from '@root/billing/invoices/dmz/pdf/.parent';"],
    ['<child>/.self.ts from the child code', 'root/billing/dmz/invoices/.self.ts', "export { invoice } from '@root/billing/invoices/_/invoice';"],
    ['<child>/.parent.ts from the child code', 'root/billing/dmz/invoices/.parent.ts', "export { invoice } from '@root/billing/invoices/_/invoice';"],
    ['.self/<consumer>.ts from the owner code', 'root/billing/dmz/.self/invoices.ts', "export { billingModule } from '@root/billing/_/billing.module';"],
    ['.parent/<consumer>.ts from a sibling contract', 'root/billing/dmz/.parent/invoices.ts', "export { logger } from '@root/dmz/log/billing';"],
    ['.parent/<consumer>.ts from a .self contract', 'root/billing/dmz/.parent/payments.ts', "export { main } from '@root/dmz/.self/billing';"],
  ])('allows %s', async (_name, file, statement) => {
    expect(await targetViolations(file, statement)).toEqual([]);
  });

  it.each([
    ['<child>/<consumer>.ts from another child', 'root/billing/dmz/payments/invoices.ts', "export { invoice } from '@root/billing/invoices/_/invoice';"],
    ['<child>/<consumer>.ts from the owner code', 'root/billing/dmz/payments/invoices.ts', "export { billingModule } from '@root/billing/_/billing.module';"],
    ['<child>/.self.ts from an unrelated bucket', 'root/billing/dmz/invoices/.self.ts', "export { logger } from '@root/log/_/logger';"],
    ['<child>/.parent.ts from a sibling', 'root/billing/dmz/invoices/.parent.ts', "export { pay } from '@root/billing/payments/_/pay';"],
    ['<child>/<consumer>.ts from a grandchild directly', 'root/billing/dmz/invoices/payments.ts', "export { pdf } from '@root/billing/invoices/pdf/_/pdf';"],
    ['.self/<consumer>.ts from a child', 'root/billing/dmz/.self/invoices.ts', "export { pay } from '@root/billing/payments/_/pay';"],
    ['.parent/<consumer>.ts from code outside', 'root/billing/dmz/.parent/invoices.ts', "export { logger } from '@root/log/_/logger';"],
    ['.parent/<consumer>.ts from a contract for another consumer', 'root/billing/dmz/.parent/invoices.ts', "export { logger } from '@root/dmz/log/.self';"],
  ])('rejects %s', async (_name, file, statement) => {
    const dir = makeProject({ ...BASE, 'root/dmz/log/.self.ts': "export { logger } from '@root/log/_/logger';\n", [file]: `${statement}\n` });
    const { report } = await checkProject(dir);
    const targets = report.violations.filter((v) => v.rule === 'dmz-target');
    expect(targets.map((v) => v.file)).toEqual([file]);
    expect(targets[0]!.line).toBe(1);
    expect(targets[0]!.message).toMatch(/may only re-export from/);
  });
});

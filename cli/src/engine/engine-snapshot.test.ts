// The inspect snapshot of the engine.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects } from '../testing/fixture.js';
import { BASE_FILES, baseConfig, engine, project } from './engine-test-kit.js';

afterEach(cleanupProjects);

describe('snapshot', () => {
  it('describes buckets, edges, files and violations from the same graph', async () => {
    const dir = project({ ...BASE_FILES, 'src/stray.ts': 'export const s = 1;\n' });
    const s = await engine().snapshot(dir);
    expect(s.snapshotVersion).toBe(2);
    const p = s.projects[0]!;
    expect(p.path).toBe('.');
    expect(p.buckets.map((b) => b.name)).toEqual(['billing', 'payments']);
    expect(p.edges).toEqual([{ from: 'billing', to: 'payments', state: 'used', reason: 'Charges go through the gateway', imports: [{ file: 'src/billing/main.ts', line: 1, target: 'src/payments/index.ts', names: ['charge'], private: false }] }]);
    const payments = p.buckets.find((b) => b.name === 'payments')!;
    expect(payments.public[0]?.exports).toEqual([{ name: 'charge', line: 1, typeOnly: false, consumers: [{ bucket: 'billing', file: 'src/billing/main.ts', line: 1 }] }]);
    expect(payments.dependents).toEqual([{ bucket: 'billing', names: ['charge'] }]);
    expect(p.files).toContainEqual({ dir: 'src', owner: { state: 'unowned' }, names: ['stray.ts'] });
    expect(p.violations.map((v) => v.rule)).toEqual(['file-unowned']);
  });

  it('lists every public file, the packages with their imports, private imports and the advice', async () => {
    const files = { ...BASE_FILES, 'src/payments/fee.ts': "import { z } from 'zod';\nexport const fee = z;\n", 'src/billing/main.ts': "import { charge } from '../payments';\nimport { fee } from '../payments/fee';\nconsole.log(charge(1), fee);\n" };
    const config = baseConfig((c) => {
      c.buckets.payments.public = ['src/payments/index.ts', 'src/payments/gone.ts'];
      c.buckets.payments.packages = { 'node:fs': 'Writes the receipts to disk' };
      c.buckets.billing.purpose = 'Bills';
    });
    const p = (await engine().snapshot(project(files, config))).projects[0]!;
    const payments = p.buckets.find((b) => b.name === 'payments')!;
    expect(payments.public.map((x) => [x.file, x.exists])).toEqual([
      ['src/payments/index.ts', true],
      ['src/payments/gone.ts', false],
    ]);
    expect(payments.packages).toEqual([
      { name: 'node:fs', state: 'unused', reason: 'Writes the receipts to disk', imports: [] },
      { name: 'zod', state: 'undeclared', reason: null, imports: [{ file: 'src/payments/fee.ts', line: 1, specifier: 'zod' }] },
    ]);
    expect(p.edges[0]!.imports.map((i) => [i.target, i.private])).toEqual([
      ['src/payments/index.ts', false],
      ['src/payments/fee.ts', true],
    ]);
    expect(p.advice).toEqual([{ advice: 'reason-generic', project: '.', at: ['buckets', 'billing', 'purpose'], text: 'Bills', why: 'short' }]);
  });
});

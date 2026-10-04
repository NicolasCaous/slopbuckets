import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../../testing/fixture.js';
import { checkProject, testContext } from '../../testing/harness.js';
import { addBarrelUses, type BucketImport } from './barrels.js';
import type { DmzUse } from './imports.js';

afterEach(cleanupProjects);

const DMZ = 'root/dmz/b/a.ts';

function dmzUse(file: string, names: string[]): DmzUse {
  return { file, bucket: 'root/a', line: 1, target: DMZ, names, usedNames: [] };
}

describe('addBarrelUses', () => {
  it('counts a re-exported DMZ name when another file of the bucket imports it from the barrel and uses it', () => {
    const use = dmzUse('root/a/_/index.ts', ['helper', 'other']);
    addBarrelUses([
      { file: 'root/a/_/index.ts', target: DMZ, usedNames: [], reexportedAs: [{ name: 'helper', as: 'helper' }, { name: 'other', as: 'other' }], dmzUse: use },
      { file: 'root/a/_/use.ts', target: 'root/a/_/index.ts', usedNames: ['helper'], reexportedAs: [] },
    ]);
    expect(use.usedNames).toEqual(['helper']);
  });

  it('follows renames, default exports, export * and chains of barrels', () => {
    const use = dmzUse('root/a/_/inner.ts', ['helper', 'h2', 'h3']);
    const imports: BucketImport[] = [
      // inner.ts: import { helper, h2, h3 } from DMZ; export { helper as renamed }; export default h2; export { h3 };
      {
        file: 'root/a/_/inner.ts',
        target: DMZ,
        usedNames: [],
        reexportedAs: [
          { name: 'helper', as: 'renamed' },
          { name: 'h2', as: 'default' },
          { name: 'h3', as: 'h3' },
        ],
        dmzUse: use,
      },
      // outer.ts: export * from inner; export { default as second } from inner;
      { file: 'root/a/_/outer.ts', target: 'root/a/_/inner.ts', usedNames: [], reexportedAs: [{ name: '*', as: '*' }] },
      { file: 'root/a/_/outer.ts', target: 'root/a/_/inner.ts', usedNames: [], reexportedAs: [{ name: 'default', as: 'second' }] },
      { file: 'root/a/_/use.ts', target: 'root/a/_/outer.ts', usedNames: ['renamed', 'second'], reexportedAs: [] },
    ];
    addBarrelUses(imports);
    expect(use.usedNames.sort()).toEqual(['h2', 'helper']);
  });

  it('counts every name of a barrel whose namespace import is used', () => {
    const use = dmzUse('root/a/_/index.ts', ['helper']);
    addBarrelUses([
      { file: 'root/a/_/index.ts', target: DMZ, usedNames: [], reexportedAs: [{ name: 'helper', as: 'helper' }], dmzUse: use },
      { file: 'root/a/_/use.ts', target: 'root/a/_/index.ts', usedNames: ['*'], reexportedAs: [] },
    ]);
    expect(use.usedNames).toEqual(['helper']);
  });

  it('does not count a re-export that nobody uses, or that is only re-exported again', () => {
    const use = dmzUse('root/a/_/index.ts', ['helper']);
    addBarrelUses([
      { file: 'root/a/_/index.ts', target: DMZ, usedNames: [], reexportedAs: [{ name: 'helper', as: 'helper' }], dmzUse: use },
      { file: 'root/a/_/again.ts', target: 'root/a/_/index.ts', usedNames: [], reexportedAs: [{ name: 'helper', as: 'helper' }] },
      { file: 'root/a/_/other.ts', target: 'root/a/_/index.ts', usedNames: ['somethingElse'], reexportedAs: [] },
    ]);
    expect(use.usedNames).toEqual([]);
  });

  it('terminates on barrels that re-export from each other', () => {
    const use = dmzUse('root/a/_/x.ts', ['helper']);
    addBarrelUses([
      { file: 'root/a/_/x.ts', target: DMZ, usedNames: [], reexportedAs: [{ name: 'helper', as: 'helper' }], dmzUse: use },
      { file: 'root/a/_/x.ts', target: 'root/a/_/y.ts', usedNames: [], reexportedAs: [{ name: '*', as: '*' }] },
      { file: 'root/a/_/y.ts', target: 'root/a/_/x.ts', usedNames: [], reexportedAs: [{ name: '*', as: '*' }] },
    ]);
    expect(use.usedNames).toEqual([]);
  });
});

describe('barrels in a check', () => {
  // The invoices bucket gets the logger through a barrel in its own _/.
  const BARREL = {
    ...LOGGER_PROJECT,
    'root/billing/invoices/_/index.ts': "export { logger } from '@root/billing/dmz/.parent/invoices';\n",
  };

  it('a contract used through a barrel of the same bucket is not an orphan', async () => {
    const dir = makeProject({ ...BARREL, 'root/billing/invoices/_/create-invoice.ts': "import { logger } from '@root/billing/invoices/_/index';\nlogger('created');\n" });
    const { report } = await checkProject(dir, {}, testContext({ reportUnused: true }));
    expect(report.violations).toEqual([]);
  });

  it('a barrel that nobody uses leaves the contract orphaned, and the message names the barrel', async () => {
    const dir = makeProject({ ...BARREL, 'root/billing/invoices/_/create-invoice.ts': 'export const created = 1;\n' });
    const { report } = await checkProject(dir, {}, testContext({ reportUnused: true }));
    const orphans = report.violations.filter((v) => v.rule === 'dmz-orphan');
    expect(orphans.map((v) => v.file).sort()).toEqual(['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts']);
    for (const orphan of orphans) {
      expect(orphan.message).toContain('root/billing/invoices/_/index.ts imports it but never uses it');
      expect(orphan.message).not.toContain('no _/ code imports it');
    }
  });

  it('an import that is never referenced is named in the orphan message', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/billing/invoices/_/create-invoice.ts': "import { logger } from '@root/billing/dmz/.parent/invoices';\nexport const x = 1;\n" });
    const { report } = await checkProject(dir, {}, testContext({ reportUnused: true }));
    const orphan = report.violations.find((v) => v.rule === 'dmz-orphan' && v.file === 'root/billing/dmz/.parent/invoices.ts')!;
    expect(orphan.message).toContain('root/billing/invoices/_/create-invoice.ts imports it but never uses it');
  });

  it('a barrel used only by another bucket does not count, because that import is forbidden', async () => {
    const dir = makeProject({
      ...BARREL,
      'root/billing/invoices/_/create-invoice.ts': 'export const created = 1;\n',
      'root/billing/payments/_/pay.ts': "import { logger } from '@root/billing/invoices/_/index';\nlogger('x');\n",
    });
    const { report } = await checkProject(dir, {}, testContext({ reportUnused: true }));
    const rules = report.violations.map((v) => `${v.rule} ${v.file}`).sort();
    expect(rules).toEqual(['dmz-orphan root/billing/dmz/.parent/invoices.ts', 'dmz-orphan root/dmz/log/billing.ts', 'import-forbidden root/billing/payments/_/pay.ts']);
  });
});

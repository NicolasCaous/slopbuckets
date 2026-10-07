import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../../testing/fixture.js';
import { checkProject, testContext } from '../../testing/harness.js';
import { DEFAULT_CONFIG } from '../config.js';
import { toSpecifier, type Model } from '../model.js';

afterEach(cleanupProjects);

const FILE = 'root/billing/invoices/_/extra.ts';

/** Adds FILE with `code` to the logger project and returns the import violations on it. */
async function importViolations(code: string, extra: Record<string, string> = {}): Promise<{ rule: string; line?: number; message: string }[]> {
  const dir = makeProject({ ...LOGGER_PROJECT, ...extra, [FILE]: code });
  const { report } = await checkProject(dir);
  return report.violations.filter((v) => v.file === FILE && v.rule.startsWith('import-'));
}

describe('import rules', () => {
  it('allows own code, contracts the bucket consumes, child contracts, declared packages and built-ins', async () => {
    const code = [
      "import { invoice } from '@root/billing/invoices/_/invoice';",
      "import { logger } from '@root/billing/dmz/.parent/invoices';",
      "import { pdf } from '@root/billing/invoices/dmz/pdf/.self';",
      "import axios from 'axios';",
      "import { createHash } from 'node:crypto';",
      "import fs from 'fs';",
      'logger(invoice + pdf);',
    ].join('\n');
    const extra = {
      'buckets.config.json': '{ "root": "root" }',
      'root/billing/invoices/_/invoice.ts': 'export const invoice = 1;\n',
      'root/billing/invoices/pdf/_/pdf.ts': 'export const pdf = 1;\n',
      'root/billing/invoices/dmz/pdf/.self.ts': "export { pdf } from '@root/billing/invoices/pdf/_/pdf';\n",
    };
    expect(await importViolations(code, extra)).toEqual([]);
  });

  it('reports relative imports, even inside the same _/', async () => {
    const v = await importViolations("import { x } from './other';\n");
    expect(v.map((x) => [x.rule, x.line])).toEqual([['import-relative', 1]]);
    expect(v[0]!.message).toContain('Rewrite it with the alias, as @root/<path from root>');
  });

  it('says that code outside the project is reached only through buckets link, for a relative import that leaves the project', async () => {
    const v = await importViolations("import { x } from '../../../../../shared/x';\n");
    expect(v.map((x) => [x.rule, x.line])).toEqual([['import-relative', 1]]);
    expect(v[0]!.message).toContain('leaves this project (it points at ../shared/x, outside the project folder)');
    expect(v[0]!.message).toContain('code outside this project is reached only through `buckets link`');
    expect(v[0]!.message).toContain('`buckets link add <name> <its project folder>` in root/billing/invoices');
    // The alias of this project cannot reach code outside it, so the message does not suggest it.
    expect(v[0]!.message).not.toContain('@root');
    // A relative path that climbs but stays in the project keeps the alias advice.
    const inside = await importViolations("import { x } from '../../../../other/x';\n");
    expect(inside[0]!.message).toContain('Rewrite it with the alias');
  });

  it('reports dynamic import() and require()', async () => {
    const v = await importViolations("const a = 1;\nconst m = await import('@root/log/_/logger');\nconst n = require(name);\n");
    expect(v.map((x) => [x.rule, x.line])).toEqual([
      ['import-dynamic', 2],
      ['import-dynamic', 3],
    ]);
  });

  it('reports unresolved internal imports', async () => {
    const v = await importViolations("import { x } from '@root/nowhere/_/x';\n");
    expect(v.map((x) => x.rule)).toEqual(['import-unresolved']);
  });

  it('reports undeclared packages', async () => {
    const v = await importViolations("import left from 'left-pad';\nimport axios from 'axios';\n");
    expect(v.map((x) => [x.rule, x.line])).toEqual([['import-undeclared-package', 1]]);
  });

  it.each([
    ['code of another bucket', "import { logger } from '@root/log/_/logger';"],
    ['code of the parent bucket', "import { billing } from '@root/billing/_/billing.module';"],
    ['a contract for a sibling', "import { x } from '@root/billing/dmz/invoices/payments';"],
    ['a contract two levels up', "import { logger } from '@root/dmz/log/billing';"],
    ['a contract the bucket exposes upward', "import { x } from '@root/billing/dmz/invoices/.parent';"],
  ])('reports import-forbidden for %s', async (_name, statement) => {
    const extra = {
      'root/billing/dmz/invoices/.parent.ts': "export { x } from '@root/billing/invoices/_/x';\n",
      'root/billing/invoices/_/x.ts': 'export const x = 1;\n',
      'root/billing/dmz/invoices/payments.ts': "export { x } from '@root/billing/invoices/_/x';\n",
    };
    const v = await importViolations(`${statement}\n`, extra);
    expect(v.map((x) => x.rule)).toEqual(['import-forbidden']);
    expect(v[0]!.message).toContain('may import only');
  });

  it('suggests the sibling contract when importing sibling code', async () => {
    const v = await importViolations("import { pay } from '@root/billing/payments/_/pay';\n");
    expect(v[0]!.message).toContain('root/billing/dmz/payments/invoices.ts');
    // The agent reads this message: the approval it can ask for is `buckets refresh --web`.
    expect(v[0]!.message).toContain('`buckets refresh --web`');
  });

  it('reports import * as from a DMZ file', async () => {
    const v = await importViolations("import * as log from '@root/billing/dmz/.parent/invoices';\n");
    expect(v.map((x) => x.rule)).toEqual(['import-namespace-dmz']);
  });

  it('allows import * as from own code', async () => {
    const v = await importViolations("import * as inv from '@root/billing/invoices/_/create-invoice';\n");
    expect(v).toEqual([]);
  });

  it('applies the same rules to export ... from inside _/', async () => {
    const v = await importViolations("export { logger } from '@root/log/_/logger';\n");
    expect(v.map((x) => x.rule)).toEqual(['import-forbidden']);
  });

  it('lets root code import contracts its children offer through .self', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'root/dmz/log/.self.ts': "export { logger } from '@root/log/_/logger';\n",
      'root/_/main.ts': "import { logger } from '@root/dmz/log/.self';\nlogger('x');\n",
    });
    const { report } = await checkProject(dir);
    expect(report.violations.filter((v) => v.file === 'root/_/main.ts')).toEqual([]);
  });
});

describe('import-global', () => {
  it('reports each global the adapter finds in a code file, with its line', async () => {
    const v = await importViolations("/// <reference path='./other.ts' />\nexport const a = 1;\ndeclare global {\n  var shared: number;\n}\n");
    expect(v.map((x) => `${x.rule} ${x.line}`)).toEqual(['import-global 1', 'import-global 3']);
    expect(v[1]!.message).toContain('`declare global` adds names to the global scope.');
    expect(v[1]!.message).toContain('only through import statements');
  });

  it('accepts a response without globals', async () => {
    expect(await importViolations('export const a = 1;\n')).toEqual([]);
  });

  it('is reported by check --file on that file only', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, [FILE]: 'declare global {\n  var shared: number;\n}\nexport {};\n', 'root/_/main.ts': 'declare global {}\n' });
    const { report } = await checkProject(dir, { file: FILE });
    expect(report.violations.map((x) => `${x.rule} ${x.file} ${x.line}`)).toEqual([`import-global ${FILE} 1`]);
    expect(report.exitCode).toBe(1);
  });
});

describe('import-global advice', () => {
  it('uses the adapter message as the fix, without generic advice that may contradict it', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, [FILE]: 'declare global {\n  var shared: number;\n}\nexport {};\n' });
    const { report } = await checkProject(dir);
    const v = report.violations.find((x) => x.file === FILE && x.rule === 'import-global')!;
    expect(v.message).toContain('`declare global` adds names to the global scope.');
    expect(v.message).toContain('only through import statements');
    expect(v.message).not.toContain('Make the file a module');
  });
});

describe('internal targets outside the root folder', () => {
  /** A context whose adapter reports one import of `target` from FILE, as a `paths` entry outside root would. */
  function contextWithTarget(target: string) {
    const ctx = testContext();
    const analyze = ctx.adapter.analyze.bind(ctx.adapter);
    ctx.adapter.analyze = async (projectDir, request) => {
      const response = await analyze(projectDir, request);
      response.code[FILE] = { imports: [{ kind: 'internal', target, names: ['s'], line: 1 }] };
      return response;
    };
    return ctx;
  }

  it.each(['shared/s.ts', '../shared/s.ts'])('reports import-forbidden for %s with the project path and no alias', async (target) => {
    const dir = makeProject({ ...LOGGER_PROJECT, [FILE]: 'export const x = 1;\n' });
    const { report } = await checkProject(dir, {}, contextWithTarget(target));
    expect(report.violations.map((v) => `${v.rule} ${v.file}`)).toEqual([`import-forbidden ${FILE}`]);
    const message = report.violations[0]!.message;
    expect(message).toContain(`Import of ${target} is outside what bucket root/billing/invoices may import`);
    expect(message).toContain('outside root/');
    expect(message).not.toContain('@root/shared');
    expect(message).not.toContain('could not be resolved');
  });
});

describe('toSpecifier', () => {
  it('writes the alias for files under the root folder and keeps any other path', async () => {
    const model = { config: { ...DEFAULT_CONFIG } } as unknown as Model;
    expect(toSpecifier(model, 'root/a/_/x.ts')).toBe('@root/a/_/x');
    expect(toSpecifier(model, 'root/a/_/logo.svg')).toBe('@root/a/_/logo');
    expect(toSpecifier(model, 'shared/s.ts')).toBe('shared/s.ts');
    expect(toSpecifier(model, '../shared/s.ts')).toBe('../shared/s.ts');
  });

  it('drops the whole declaration extension of a .d.ts file, such as the index of a link', () => {
    const model = { config: { ...DEFAULT_CONFIG } } as unknown as Model;
    expect(toSpecifier(model, 'root/a/_/links/api/index.d.ts')).toBe('@root/a/_/links/api/index');
    expect(toSpecifier(model, 'root/a/_/types.d.mts')).toBe('@root/a/_/types');
  });
});

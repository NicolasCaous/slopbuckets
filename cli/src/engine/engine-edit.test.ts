// checkEdit, the cache and recheck: an edit simulated before it lands, and the answers from the cache.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, removeFile, writeFile } from '../testing/fixture.js';
import { BASE_FILES, baseConfig, bucket, engine, keys, project, rules } from './engine-test-kit.js';
import { createEngine } from './engine.js';

afterEach(cleanupProjects);

describe('checkEdit', () => {
  it('gives what checkAll gives after the same edits are written (random edits)', async () => {
    const config = baseConfig((c) => {
      c.buckets.log = bucket('log');
      c.buckets.billing.dependsOn.log = 'Logs failed charges';
      c.ignore = ['scripts/**'];
    });
    const dir = project(
      {
        ...BASE_FILES,
        'src/log/index.ts': "export { log } from './write';\n",
        'src/log/write.ts': 'export const log = (s: string) => s;\n',
        'src/billing/main.ts': "import { charge } from '../payments';\nimport { log } from '../log';\nlog(String(charge(1)));\n",
        'src/billing/util.ts': 'export const u = 1;\n',
        'scripts/env.ts': 'export const env = 1;\n',
      },
      config,
    );
    const e = engine();
    let current = (await e.checkAll(dir)).violations;
    const variants: [string, string | null][] = [
      ['src/billing/util.ts', "import { charge } from '../payments/charge';\nexport const u = charge;\n"],
      ['src/billing/main.ts', 'export {};\n'],
      ['src/billing/util.ts', "import * as l from '../log';\nexport const u = l;\n"],
      ['src/payments/index.ts', "export { charge } from './charge';\nexport const extra = 1;\n"],
      ['src/billing/brand-new.ts', "import { env } from '../../scripts/env';\nexport const b = env;\n"],
      ['src/log/write.ts', null],
      ['src/stray/a.ts', 'export const a = (n: string) => import(n);\n'],
      ['src/payments/charge.ts', "export const charge = (n: number) => n;\nexport { u } from '../billing/util';\n"],
    ];
    let seed = 7;
    const order = variants.map((v, i) => ({ v, r: (seed = (seed * 48271) % 2147483647) + i })).sort((a, b) => a.r - b.r);
    for (const { v: [file, content] } of order) {
      const abs = path.join(dir, file);
      const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      const simulated = await e.checkEdit(dir, { path: file, content });
      if (content === null) rmSync(abs);
      else writeFile(dir, file, content);
      // recheck of the violations before the edit keeps exactly the ones a full check still reports
      const rechecked = keys(await e.recheck(dir, current));
      const full = await e.checkAll(dir);
      expect(keys(simulated.violations), `edit of ${file}`).toEqual(keys(full.violations));
      expect(rechecked, `recheck after ${file}`).toEqual(keys(current).filter((k) => keys(full.violations).includes(k)));
      if (before === null) rmSync(abs);
      else writeFile(dir, file, before);
      current = (await e.checkAll(dir)).violations;
    }
    // a config edit
    const edited = JSON.stringify(baseConfig((c) => ((c.buckets.log = bucket('log')), (c.ignore = ['scripts/**']))), null, 2);
    const simulated = await e.checkEdit(dir, { path: 'buckets.config.json', content: edited });
    writeFile(dir, 'buckets.config.json', edited);
    expect(keys(simulated.violations)).toEqual(keys((await e.checkAll(dir)).violations));
  });

  it('sees what a shell command did in the folder of the edited file, without the files git ignores', async () => {
    const dir = project({ ...BASE_FILES, 'src/billing/util.ts': 'export const u = 1;\n', 'src/billing/old.ts': 'export const o = 1;\n', '.gitignore': 'src/billing/gen.ts\n' });
    const e = engine();
    await e.checkAll(dir);
    const privateImport = "import { charge } from '../payments/charge';\nexport const x = charge;\n";
    writeFile(dir, 'src/billing/util.ts', privateImport);
    writeFile(dir, 'src/billing/extra.ts', privateImport);
    writeFile(dir, 'src/billing/gen.ts', privateImport);
    removeFile(dir, 'src/billing/old.ts');
    const content = "import { charge } from '../payments';\nconsole.log(charge(2));\n";
    const simulated = await e.checkEdit(dir, { path: 'src/billing/main.ts', content });
    writeFile(dir, 'src/billing/main.ts', content);
    const full = await e.checkAll(dir);
    expect(rules(full)).toEqual(['import-private']);
    expect(full.violations.flatMap((v) => (v.rule === 'import-private' ? v.imports.map((i) => i.file) : []))).toEqual(['src/billing/extra.ts', 'src/billing/util.ts']);
    expect(keys(simulated.violations)).toEqual(keys(full.violations));
  });

  it('reports config-invalid for an edit that breaks the config, without writing it', async () => {
    const dir = project(BASE_FILES);
    const r = await engine().checkEdit(dir, { path: path.join(dir, 'buckets.config.json'), content: '{ "buckets": { "billing": {} } }' });
    expect(new Set(rules(r))).toEqual(new Set(['config-invalid']));
    expect((await engine().checkAll(dir)).violations).toEqual([]);
  });

  it('names a bucket key renamed in an edit of the config as bucket-renamed', async () => {
    const dir = project(BASE_FILES);
    const renamed = baseConfig((c) => {
      c.buckets.gateway = c.buckets.payments;
      delete c.buckets.payments;
    });
    const r = await engine().checkEdit(dir, { path: 'buckets.config.json', content: JSON.stringify(renamed) });
    expect(r.violations).toEqual([{ rule: 'config-invalid', project: '.', problem: { kind: 'bucket-renamed', from: 'payments', to: 'gateway', referencedBy: ['billing'] } }]);
    // checkAll of the same text on disk has no earlier config to compare with
    writeFile(dir, 'buckets.config.json', JSON.stringify(renamed));
    expect((await engine().checkAll(dir)).violations).toEqual([{ rule: 'config-invalid', project: '.', problem: { kind: 'unknown-bucket', bucket: 'billing', dependency: 'payments' } }]);
  });

  it('takes several files in one call', async () => {
    const dir = project(BASE_FILES);
    const r = await engine().checkEdit(dir, [
      { path: 'src/billing/main.ts', content: "import { refund } from '../payments';\nconsole.log(refund);\n" },
      { path: 'src/payments/index.ts', content: "export { charge as refund } from './charge';\n" },
    ]);
    expect(r.violations).toEqual([]);
  });
});

describe('the cache', () => {
  it('sees a changed file, a changed tsconfig and a changed config', async () => {
    const dir = project({ ...BASE_FILES, 'src/billing/charge.ts': 'export const charge = 2;\n' });
    const e = engine();
    expect((await e.checkAll(dir)).violations).toEqual([]);
    writeFile(dir, 'src/billing/main.ts', "import { charge } from '@p/charge';\nconsole.log(charge);\n");
    expect(rules(await e.checkAll(dir))).toEqual(['import-private']);
    // @p now points into billing itself: no cross-bucket import left
    writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@p/*': ['./src/billing/*'] } } }));
    expect(rules(await e.checkAll(dir))).toEqual(['dependency-unused', 'export-unused']);
    writeFile(dir, 'buckets.config.json', JSON.stringify(baseConfig((c) => ((c.buckets.billing.dependsOn = {}), (c.buckets.payments.external = 'Used by the app')))));
    expect((await e.checkAll(dir)).violations).toEqual([]);
  });

  it('starts over after a cache from another CLI version', async () => {
    const dir = project(BASE_FILES);
    await createEngine({ cliVersion: 'old' }).checkAll(dir);
    writeFile(dir, 'src/stray.ts', 'export const s = 1;\n');
    expect(rules(await engine().checkAll(dir))).toEqual(['file-unowned']);
  });
});

describe('recheck', () => {
  it('keeps the violations that remain on disk and drops the fixed ones', async () => {
    const dir = project({
      ...BASE_FILES,
      'src/billing/main.ts': "import { charge } from '../payments/charge';\nconsole.log(charge);\n",
      'src/stray.ts': 'export const s = 1;\n',
    });
    const e = engine();
    const all = (await e.checkAll(dir)).violations;
    expect(rules(all)).toEqual(['file-unowned', 'import-private']);
    expect(keys(await e.recheck(dir, all))).toEqual(keys(all));
    removeFile(dir, 'src/stray.ts');
    writeFile(dir, 'src/billing/main.ts', "import { charge } from '../payments';\nconsole.log(charge);\n");
    expect(await e.recheck(dir, all)).toEqual([]);
  });

  it('answers from state.json when an adapter input lies outside the project', async () => {
    const dir = project({ ...BASE_FILES, 'src/stray.ts': 'export const s = 1;\n' });
    const all = (await engine().checkAll(dir)).violations;
    const at = path.join(dir, '.buckets', 'cache', 'state.json');
    const state = JSON.parse(readFileSync(at, 'utf8'));
    // The package.json of typescript sits under node_modules, so the adapter names it by an absolute path.
    expect(Object.keys(state.inputs).some((p) => path.isAbsolute(p))).toBe(true);
    // The fast path returns the keys of state.json without running the rules, so an empty list there comes back.
    writeFileSync(at, JSON.stringify({ ...state, keys: [] }));
    expect(await engine().recheck(dir, all)).toEqual([]);
  });

  it('keeps a project-wide violation that an edit caused once the edit lands', async () => {
    const dir = project(BASE_FILES);
    const e = engine();
    await e.checkAll(dir);
    const content = 'export {};\n';
    const simulated = await e.checkEdit(dir, { path: 'src/billing/main.ts', content });
    expect(rules(simulated)).toEqual(['dependency-unused', 'export-unused']);
    writeFile(dir, 'src/billing/main.ts', content);
    expect(rules(await e.recheck(dir, simulated.violations))).toEqual(['dependency-unused', 'export-unused']);
  });

  it('drops a violation of an edit that never landed', async () => {
    const dir = project(BASE_FILES);
    const e = engine();
    await e.checkAll(dir);
    const simulated = await e.checkEdit(dir, { path: 'src/billing/main.ts', content: "import { charge } from '../payments/charge';\nconsole.log(charge);\n" });
    expect(rules(simulated)).toEqual(['import-private']);
    expect(await e.recheck(dir, simulated.violations)).toEqual([]);
  });
});

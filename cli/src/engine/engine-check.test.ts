// checkAll of the rule engine: results, environment errors, nested projects and the file listing.
import { mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, removeFile, TMP_ROOT, writeFile } from '../testing/fixture.js';
import { fillerOnly } from './rules.js';
import { BASE_FILES, baseConfig, bucket, check, engine, git, project, rules, TSCONFIG } from './engine-test-kit.js';

afterEach(cleanupProjects);

describe('the rule engine', () => {
  it('finds nothing in a clean project, twice (cold and from the cache)', async () => {
    const dir = project(BASE_FILES);
    const e = engine();
    const cold = await e.checkAll(dir);
    expect(cold).toEqual({ exitCode: 0, violations: [], environment: [], advice: [], projects: ['.'] });
    expect(await e.checkAll(dir)).toEqual(cold);
  });

  it('takes declared packages and Node built-ins, and imports inside one bucket', async () => {
    const files = {
      ...BASE_FILES,
      'src/billing/main.ts':
        "import { charge } from '../payments';\nimport fs from 'node:fs';\nimport path from 'path';\nimport type { AxiosStatic } from 'axios';\nimport merge from 'lodash/merge';\nimport * as y from './util';\nconsole.log(charge, fs, path, merge, y);\n",
      'src/billing/util.ts': 'export const u = 1;\n',
      // ignored files need no packages entry
      'scripts/tool.ts': "import { execSync } from 'node:child_process';\nexecSync('x');\n",
    };
    const packages = { 'node:fs': 'Reads the invoice templates', 'node:path': 'Joins the template paths', axios: 'Types the gateway client', lodash: 'Merges invoice defaults' };
    const r = await check(files, baseConfig((c) => ((c.buckets.billing.packages = packages), (c.ignore = ['scripts/**']))));
    expect(r.violations).toEqual([]);
  });

  it('reports packages a bucket imports without declaring, and declared packages it never imports', async () => {
    const files = { ...BASE_FILES, 'src/billing/main.ts': "import { charge } from '../payments';\nimport { readFileSync } from 'fs';\nimport { z } from 'zod';\nconsole.log(charge, readFileSync, z);\n" };
    const r = await check(files, baseConfig((c) => ((c.buckets.billing.packages = { zod: 'Validates the invoice payloads' }), (c.buckets.payments.packages = { 'node:fs': 'Writes the receipts', 'node:os': 'Reads the host name of the receipt' }))));
    expect(r.violations.filter((v) => v.rule.startsWith('package-'))).toEqual([
      { rule: 'package-unused', project: '.', bucket: 'payments', package: 'node:fs', reason: 'Writes the receipts' },
      { rule: 'package-unused', project: '.', bucket: 'payments', package: 'node:os', reason: 'Reads the host name of the receipt' },
      {
        rule: 'package-undeclared',
        project: '.',
        bucket: 'billing',
        purpose: 'Keeps the billing rules and records',
        package: 'node:fs',
        imports: [{ file: 'src/billing/main.ts', line: 2, specifier: 'fs' }],
        declaredBy: [{ bucket: 'payments', reason: 'Writes the receipts' }],
      },
    ]);
  });

  it('reports unresolved imports and holds back what they could explain', async () => {
    const files = { ...BASE_FILES, 'src/billing/main.ts': "import { charge } from '../payments/gone';\nimport { x } from '@p/missing';\nconsole.log(charge, x);\n" };
    const r = await check(files);
    expect(r.violations).toEqual([
      { rule: 'import-unresolved', project: '.', bucket: 'billing', file: 'src/billing/main.ts', line: 1, specifier: '../payments/gone', kind: 'relative', pattern: null },
      { rule: 'import-unresolved', project: '.', bucket: 'billing', file: 'src/billing/main.ts', line: 2, specifier: '@p/missing', kind: 'paths', pattern: '@p/*' },
    ]);
  });

  it('groups private imports per declared pair, and puts those of an undeclared pair in dependency-undeclared', async () => {
    const files = {
      ...BASE_FILES,
      'src/payments/fee.ts': 'export type Fee = number;\nexport const fee = 1;\n',
      'src/billing/main.ts': "import { charge } from '../payments/charge';\nimport { type Fee, fee } from '../payments/fee';\nconsole.log(charge, fee);\n",
      'src/log/index.ts': "export { log } from './log';\n",
      'src/log/log.ts': "import { charge } from '../payments';\nimport { fee } from '../payments/fee';\nexport const log = () => charge(fee);\n",
      'src/app/main.ts': "import { log } from '../log';\nlog();\n",
    };
    const config = baseConfig((c) => {
      c.buckets.log = bucket('log', { dependsOn: {} });
      c.buckets.app = bucket('app', { public: null, dependsOn: { log: 'Logs every request' } });
      c.buckets.payments.dependsOn = { app: 'Starts inside the app' };
    });
    const r = await check(files, config);
    const pick = (rule: string) => r.violations.filter((v) => v.rule === rule);
    expect(pick('import-private')).toEqual([
      {
        rule: 'import-private',
        project: '.',
        from: 'billing',
        to: 'payments',
        imports: [
          { file: 'src/billing/main.ts', line: 1, target: 'src/payments/charge.ts', names: [{ name: 'charge', typeOnly: false }] },
          { file: 'src/billing/main.ts', line: 2, target: 'src/payments/fee.ts', names: [{ name: 'Fee', typeOnly: true }, { name: 'fee', typeOnly: false }] },
        ],
        public: ['src/payments/index.ts'],
        // The public file already has export { charge } from './charge'.
        reexported: [{ target: 'src/payments/charge.ts', name: 'charge' }],
      },
    ]);
    expect(pick('dependency-undeclared')).toEqual([
      {
        rule: 'dependency-undeclared',
        project: '.',
        from: 'log',
        to: 'payments',
        fromPurpose: 'Keeps the log rules and records',
        toPurpose: 'Keeps the payments rules and records',
        imports: [
          { file: 'src/log/log.ts', line: 1, target: 'src/payments/index.ts', names: [{ name: 'charge', typeOnly: false }], private: false },
          { file: 'src/log/log.ts', line: 2, target: 'src/payments/fee.ts', names: [{ name: 'fee', typeOnly: false }], private: true },
        ],
        public: ['src/payments/index.ts'],
        dependents: [{ bucket: 'billing', reason: 'Charges go through the gateway' }],
        reversePath: ['payments', 'app', 'log'],
      },
    ]);
    // charge is used through the public file, fee through a private path: no export-unused
    expect(pick('export-unused')).toEqual([]);
  });

  it('checks every listed public file, and names the edges of a cycle with their first import', async () => {
    const files = { ...BASE_FILES, 'src/payments/server.ts': "export { charge as serverCharge } from './charge';\n", 'src/payments/fee.ts': 'export const fee = 1;\n' };
    const config = baseConfig((c) => {
      c.buckets.payments.public = ['src/payments/index.ts', 'src/payments/server.ts', 'src/payments/fee.ts', 'src/payments/gone.ts'];
      c.buckets.payments.dependsOn = { billing: 'Sends the receipts' };
    });
    const r = await check(files, config);
    expect(r.violations.map((v) => [v.rule, 'public' in v && typeof v.public === 'string' ? v.public : ''])).toEqual([
      ['config-cycle', ''],
      ['dependency-unused', ''],
      ['export-unused', 'src/payments/fee.ts'],
      ['public-not-interface', 'src/payments/fee.ts'],
      ['public-missing', 'src/payments/gone.ts'],
      ['export-unused', 'src/payments/server.ts'],
    ]);
    expect(r.violations[0]).toMatchObject({
      cycle: ['billing', 'payments'],
      edges: [
        { from: 'billing', to: 'payments', reason: 'Charges go through the gateway', import: { file: 'src/billing/main.ts', line: 1, target: 'src/payments/index.ts', names: [{ name: 'charge', typeOnly: false }] } },
        { from: 'payments', to: 'billing', reason: 'Sends the receipts', import: null },
      ],
    });
  });

  it('stops at a config of a newer version without reading the rest', async () => {
    const r = await check(BASE_FILES, { version: '2.9', buckets: { anything: { new: 'field' } } });
    expect(r.exitCode).toBe(3);
    expect(r.violations).toEqual([]);
    expect(r.environment).toEqual([{ code: 'config-newer', project: '.', message: expect.stringContaining('2.9') }]);
  });

  it('gives advice for generic reasons and large ignore globs, apart from the violations', async () => {
    const files = { ...BASE_FILES, 'gen/a.ts': 'export {};\n', 'gen/b.ts': 'export {};\n' };
    const r = await check(files, baseConfig((c) => ((c.ignore = ['gen/**']), (c.buckets.billing.dependsOn = { payments: 'Uses payments' }))));
    expect(r.violations).toEqual([]);
    expect(r.advice).toEqual([
      { advice: 'reason-generic', project: '.', at: ['buckets', 'billing', 'dependsOn', 'payments'], text: 'Uses payments', why: 'generic' },
      { advice: 'ignore-large', project: '.', at: ['ignore', 0], glob: 'gen/**', count: 2, total: 5 },
    ]);
  });

  it('gives reason-generic for a purpose of filler words and bucket names only, and none for a normal purpose', async () => {
    const r = await check(BASE_FILES, baseConfig((c) => ((c.buckets.billing.purpose = 'Does the billing job'), (c.buckets.payments.purpose = 'Handles all the payments stuff'))));
    expect(r.advice).toEqual([
      { advice: 'reason-generic', project: '.', at: ['buckets', 'billing', 'purpose'], text: 'Does the billing job', why: 'generic' },
      { advice: 'reason-generic', project: '.', at: ['buckets', 'payments', 'purpose'], text: 'Handles all the payments stuff', why: 'generic' },
    ]);
    const names = new Set(['billing', 'payments']);
    for (const purpose of ['Handles the checkout flow and its retries', 'Does tax math for invoices', 'Charges cards through the gateway', 'Code that renders invoices to PDF']) {
      expect(fillerOnly(purpose, names), purpose).toBe(false);
    }
  });

  it('gives no ignore-large advice for globs of tests, scripts and examples, which belong in ignore', async () => {
    const tooling = { 'src/billing/invoice.test.ts': '', 'src/payments/charge.test.ts': '', 'scripts/build.mjs': '', 'scripts/release.mjs': '', 'examples/demo/app.ts': '' };
    const r = await check({ ...BASE_FILES, ...tooling }, baseConfig((c) => (c.ignore = ['**/*.test.ts', 'scripts/**', 'examples/**'])));
    expect(r.violations).toEqual([]);
    expect(r.advice).toEqual([]);
  });


  it('groups a folder of unowned files', async () => {
    const legacy = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`src/legacy/l${i}.ts`, `export const l${i} = 1;\n`]));
    const r = await check({ ...BASE_FILES, ...legacy });
    expect(r.violations).toEqual([{ rule: 'file-unowned', project: '.', folder: 'src/legacy/**', count: 5 }]);
  });

  it('lets ignore win over a bucket glob, and exclusions take files back', async () => {
    const r = await check(
      { ...BASE_FILES, 'src/billing/main.test.ts': "import { charge } from '../payments/charge';\nconsole.log(charge);\n", 'src/billing/vendor/v.ts': 'export const v = 1;\n' },
      baseConfig((c) => {
        c.ignore = ['**/*.test.ts'];
        c.buckets.billing.files = ['src/billing/**', '!src/billing/vendor/**'];
        c.buckets.vendor = bucket('vendor', { files: ['src/billing/vendor/**'], public: null });
      }),
    );
    expect(r.violations).toEqual([]);
  });

  it('counts import type and renamed imports for export-unused, but not imports from tests', async () => {
    const files = {
      ...BASE_FILES,
      'src/payments/index.ts': "export { charge as pay } from './charge';\nexport type { Fee } from './charge';\nexport { refund } from './charge';\n",
      'src/payments/charge.ts': 'export const charge = 1;\nexport type Fee = number;\nexport const refund = 2;\n',
      'src/billing/main.ts': "import { pay } from '../payments';\nimport type { Fee } from '../payments';\nconst f: Fee = pay;\nconsole.log(f);\n",
      'src/billing/main.test.ts': "import { refund } from '../payments';\nconsole.log(refund);\n",
    };
    const r = await check(files, baseConfig((c) => (c.ignore = ['**/*.test.ts'])));
    expect(r.violations.map((v) => (v.rule === 'export-unused' ? v.name : v.rule))).toEqual(['refund']);
    // external exempts the bucket
    expect((await check(files, baseConfig((c) => ((c.ignore = ['**/*.test.ts']), (c.buckets.payments.external = 'Entry of the npm package'))))).violations).toEqual([]);
  });

  it('reports every config problem and skips the other rules', async () => {
    const bad = await check(BASE_FILES, baseConfig((c) => ((c.buckets.billing.dependsOn = { ghost: '' }), (c.extra = 1))));
    expect(bad.violations.map((v) => (v.rule === 'config-invalid' ? v.problem.kind : v.rule)).sort()).toEqual(['empty', 'unknown-bucket', 'unknown-field']);
    expect(bad.exitCode).toBe(1);
    const json = await check(BASE_FILES, '{ "buckets": ');
    expect(json.violations).toMatchObject([{ rule: 'config-invalid', problem: { kind: 'json' } }]);
  });

  it('reports environment errors with exit code 3', async () => {
    const noConfig = makeProject({ 'tsconfig.json': TSCONFIG }, false);
    expect(await engine().checkAll(noConfig)).toMatchObject({ exitCode: 3, environment: [{ code: 'no-config', project: '.' }] });
    const noTsconfig = project(BASE_FILES, baseConfig(), { tsconfig: false });
    expect(await engine().checkAll(noTsconfig)).toMatchObject({ exitCode: 3, environment: [{ code: 'no-tsconfig' }], violations: [] });
  });

  it('works outside a git repository, skipping node_modules and dot folders', async () => {
    const dir = project({ ...BASE_FILES, 'node_modules/x/index.ts': 'export {};\n', '.cache/y.ts': 'export {};\n' }, baseConfig(), { git: false });
    // GIT_CEILING_DIRECTORIES of the test support keeps git from finding this repository above the project.
    expect((await engine().checkAll(dir)).violations).toEqual([]);
  });

  it('leaves out files that .gitignore lists', async () => {
    const r = await check({ ...BASE_FILES, '.gitignore': 'gen/\n', 'gen/out.ts': 'export const o = 1;\n' });
    expect(r.violations).toEqual([]);
  });

  it('resolves tsconfig paths and .js extensions to the bucket files', async () => {
    const r = await check({ ...BASE_FILES, 'src/billing/main.ts': "import { charge } from '@p/index';\nimport { charge as c2 } from '../payments/index.js';\nconsole.log(charge, c2);\n" });
    expect(r.violations).toEqual([]);
    const priv = await check({ ...BASE_FILES, 'src/billing/main.ts': "import { charge } from '@p/charge';\nconsole.log(charge);\n" });
    expect(rules(priv)).toEqual(['import-private']);
  });

  it('checks nested projects, and only the root with recursive false', async () => {
    const dir = project(
      {
        ...BASE_FILES,
        'packages/sdk/tsconfig.json': TSCONFIG,
        'packages/sdk/buckets.config.json': JSON.stringify({ version: '2.0', buckets: {} }),
        'packages/sdk/src/a.ts': 'export const a = 1;\n',
      },
      baseConfig((c) => (c.projects = ['packages/sdk'])),
    );
    const all = await engine().checkAll(dir);
    expect(all.projects).toEqual(['.', 'packages/sdk']);
    expect(all.violations).toEqual([{ rule: 'file-unowned', project: 'packages/sdk', noBuckets: true, count: 1, folders: [{ folder: 'src/**', count: 1 }], files: [] }]);
    const root = await engine().checkAll(dir, { recursive: false });
    expect(root).toEqual({ exitCode: 0, violations: [], environment: [], advice: [], projects: ['.'] });
  });

  it('treats tracked files deleted or moved on disk as gone, in checkAll and checkEdit', async () => {
    const dir = project({ ...BASE_FILES, 'src/billing/old.ts': 'export const o = 1;\n' });
    const e = engine();
    expect((await e.checkAll(dir)).violations).toEqual([]);
    removeFile(dir, 'src/billing/old.ts');
    renameSync(path.join(dir, 'src/payments/charge.ts'), path.join(dir, 'src/payments/fee.ts'));
    writeFile(dir, 'src/payments/index.ts', "export { charge } from './fee';\n");
    const after = await e.checkAll(dir);
    expect(after.violations).toEqual([]);
    const edit = await e.checkEdit(dir, { path: 'src/billing/main.ts', content: "import { charge } from '../payments/fee';\nconsole.log(charge);\n" });
    expect(rules(edit)).toEqual(['import-private']);
    // a cold run with the tracked files missing
    rmSync(path.join(dir, '.buckets'), { recursive: true, force: true });
    expect((await engine().checkAll(dir)).violations).toEqual([]);
  });

  it('lists a project in a subfolder of a repository, with untracked, changed and deleted files', async () => {
    const repo = makeProject({ 'README.md': 'repo\n', 'other/x.ts': 'export {};\n' }, false);
    for (const [f, t] of Object.entries({ ...BASE_FILES, 'src/billing/gone.ts': 'export {};\n', 'buckets.config.json': JSON.stringify(baseConfig()), 'tsconfig.json': TSCONFIG })) writeFile(repo, `app/${f}`, t);
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
    const dir = path.join(repo, 'app');
    const e = engine();
    expect((await e.checkAll(dir)).violations).toEqual([]);
    removeFile(dir, 'src/billing/gone.ts');
    writeFile(dir, 'src/stray.ts', 'export {};\n');
    writeFile(dir, 'src/billing/main.ts', "import { charge } from '../payments/charge';\nconsole.log(charge);\n");
    expect(rules(await e.checkAll(dir))).toEqual(['file-unowned', 'import-private']);
  });

  it('resolves a workspace package linked into node_modules to its bucket file', async () => {
    const dir = project({
      ...BASE_FILES,
      'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', exports: { '.': './src/index.ts' } }),
      'packages/shared/src/index.ts': "export { s } from './s';\n",
      'packages/shared/src/s.ts': 'export const s = 1;\n',
      'src/billing/main.ts': "import { charge } from '../payments';\nimport { s } from '@acme/shared';\nconsole.log(charge, s);\n",
    }, baseConfig((c) => {
      c.buckets.shared = bucket('shared', { files: ['packages/shared/**'], public: 'packages/shared/src/index.ts' });
      c.buckets.billing.dependsOn.shared = 'Shares helpers';
      c.ignore = ['packages/shared/package.json'];
    }));
    mkdirSync(path.join(dir, 'node_modules/@acme'), { recursive: true });
    symlinkSync(path.join(dir, 'packages/shared'), path.join(dir, 'node_modules/@acme/shared'), 'junction');
    const r = await engine().checkAll(dir);
    expect(r.violations.filter((v) => v.rule !== 'glob-empty')).toEqual([]);
  });

  it('sees a workspace package that an install links after a check, with the same cache', async () => {
    const dir = project(
      {
        ...BASE_FILES,
        'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
        'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', exports: { '.': './src/index.ts' } }),
        'packages/shared/src/index.ts': "export { s } from './s';\n",
        'packages/shared/src/s.ts': 'export const s = 1;\n',
        'src/billing/main.ts': "import { charge } from '../payments';\nimport { s } from '@acme/shared';\nconsole.log(charge, s);\n",
      },
      baseConfig((c) => {
        c.buckets.shared = bucket('shared', { files: ['packages/shared/src/**'], public: 'packages/shared/src/index.ts' });
      }),
    );
    const before = await engine().checkAll(dir);
    expect(before.violations).toEqual([{ rule: 'import-unresolved', project: '.', bucket: 'billing', file: 'src/billing/main.ts', line: 2, specifier: '@acme/shared', kind: 'workspace', pattern: null }]);
    // npm install: the link and the marker file it writes
    mkdirSync(path.join(dir, 'node_modules/@acme'), { recursive: true });
    symlinkSync(path.join(dir, 'packages/shared'), path.join(dir, 'node_modules/@acme/shared'), 'junction');
    writeFile(dir, 'node_modules/.package-lock.json', '{}\n');
    expect(rules(await engine().recheck(dir, before.violations))).toEqual([]);
    expect(rules(await engine().checkAll(dir))).toEqual(['dependency-undeclared']);
  });

  it('resolves each file with its nearest tsconfig.json, and checks a root without one of its own', async () => {
    const alias = JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '~/*': ['./src/*'] } } });
    const dir = project(
      {
        'apps/web/tsconfig.json': alias,
        'apps/web/src/main.ts': "import { ui } from '~/ui';\nimport { db } from '~/db';\nconsole.log(ui, db);\n",
        'apps/web/src/ui.ts': 'export const ui = 1;\n',
        'apps/api/tsconfig.json': alias,
        'apps/api/src/main.ts': "import { db } from '~/db';\nconsole.log(db);\n",
        'apps/api/src/db.ts': 'export const db = 1;\n',
        'tsconfig.base.json': '{}\n',
      },
      { version: '2.0', buckets: { web: bucket('web', { files: ['apps/web/**'], public: null }), api: bucket('api', { files: ['apps/api/**'], public: null }) } },
    );
    rmSync(path.join(dir, 'tsconfig.json'));
    const r = await engine().checkAll(dir);
    expect(r.environment).toEqual([]);
    expect(r.violations).toEqual([{ rule: 'import-unresolved', project: '.', bucket: 'web', file: 'apps/web/src/main.ts', line: 2, specifier: '~/db', kind: 'paths', pattern: '~/*' }]);
    // A root project whose only code lives in nested projects needs no tsconfig.json, and ignore hides the configs of examples.
    const root = project({ 'tsconfig.base.json': '{}\n', 'examples/a/buckets.config.json': '{}\n', 'examples/a/x.ts': 'export {};\n', 'pkg/buckets.config.json': JSON.stringify({ version: '2.0', buckets: {} }) }, { version: '2.0', ignore: ['examples/**'], projects: ['pkg'], buckets: {} });
    rmSync(path.join(root, 'tsconfig.json'));
    expect(await engine().checkAll(root)).toMatchObject({ exitCode: 0, violations: [], environment: [] });
  });

  it('handles Windows separators, spaces and capitals in paths', async () => {
    const dir = path.join(TMP_ROOT, `My Proj ${Date.now()}`);
    for (const [f, t] of Object.entries({ ...BASE_FILES, 'buckets.config.json': JSON.stringify(baseConfig()), 'tsconfig.json': TSCONFIG })) writeFile(dir, f, t);
    git(dir, 'init', '-q');
    const e = engine();
    expect((await e.checkAll(dir)).violations).toEqual([]);
    const content = "import { charge } from '../payments/charge';\nconsole.log(charge);\n";
    for (const p of [path.join(dir, 'src', 'billing', 'main.ts'), 'src\\billing\\main.ts', 'src/billing/main.ts']) {
      expect(rules(await e.checkEdit(dir, { path: p, content }))).toEqual(['import-private']);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { AdapterEnvironmentError, analyze, type ImportEntry } from './index.js';
import { CONFIG, Fixture, TSCONFIG } from './test-fixture.js';

const fixtures: Fixture[] = [];
function fixture(...args: ConstructorParameters<typeof Fixture>): Fixture {
  const created = new Fixture(...args);
  fixtures.push(created);
  return created;
}
afterAll(() => {
  for (const created of fixtures) created.remove();
});

const LOG_FILES = {
  'root/log/_/types.ts': `
export interface Entry { level: 'info' | 'warn'; message: string }
export type Level = Entry['level'];
export const a = 1;
export const b = 2;
export function helper(entry: Entry): string { return entry.message; }
`,
  'root/log/_/default.ts': 'export default function log(message: string): void { void message; }\n',
  'root/log/_/side.ts': 'console.log("loaded");\n',
  'root/log/_/dir/index.ts': 'export const fromIndex = true;\n',
  'outside/thing.ts': 'export const thing = 1;\n',
};

describe('code imports', () => {
  const project = fixture({
    ...LOG_FILES,
    'package.json': {
      name: 'fixture',
      dependencies: { axios: '^1.0.0' },
      devDependencies: { '@nestjs/core': '^10.0.0', '@types/estree': '^1.0.0' },
      peerDependencies: { react: '^19.0.0' },
      optionalDependencies: { 'left-pad': '^1.0.0' },
    },
    'root/log/_/all.ts': [
      "import { a, b as renamed } from '@root/log/_/types';",
      "import type { Entry } from '@root/log/_/types';",
      "import log from '@root/log/_/default';",
      "import * as types from '@root/log/_/types';",
      "import '@root/log/_/side';",
      "import def, * as both from '@root/log/_/default';",
      "export { helper } from '@root/log/_/types';",
      "export * from '@root/log/_/types';",
      "import { fromIndex } from '@root/log/_/dir';",
      "import { thing } from '@root/../outside/thing';",
      "import missing from '@root/nope/_/missing';",
      "import axios from 'axios';",
      "import { Controller } from '@nestjs/core/decorators';",
      "import type { Node } from 'estree';",
      "import React from 'react';",
      "import pad from 'left-pad';",
      "import { map } from 'lodash/fp';",
      "import { readFile } from 'node:fs/promises';",
      "import path from 'path';",
      "import { test } from 'node:test';",
      "import { local } from './local';",
      "import up from '../up';",
      "import sub from '#internal/sub';",
      "import fs = require('fs');",
      'const lazy = import("@root/log/_/types");',
      "const required = require('axios');",
      'const name = "x";',
      'const computed = import(name);',
      "type T = import('@root/log/_/types').Entry;",
      "type M = typeof import('@root/log/_/types');",
      "import aliasOnly from '@root';",
      '',
    ].join('\n'),
  });

  test('classifies every kind of import, in source order, with 1-based lines', async () => {
    const response = await analyze(project.dir, project.request([], ['root/log/_/all.ts']));
    const expected: ImportEntry[] = [
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['a', 'b'], line: 1 },
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['Entry'], line: 2, typeOnly: true },
      { kind: 'internal', target: 'root/log/_/default.ts', names: ['default'], line: 3 },
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['*'], line: 4 },
      { kind: 'internal', target: 'root/log/_/side.ts', names: [], line: 5 },
      { kind: 'internal', target: 'root/log/_/default.ts', names: ['default', '*'], line: 6 },
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['helper'], line: 7, reexport: true, reexportedAs: [{ name: 'helper', as: 'helper' }] },
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['*'], line: 8, reexport: true, reexportedAs: [{ name: '*', as: '*' }] },
      { kind: 'internal', target: 'root/log/_/dir/index.ts', names: ['fromIndex'], line: 9 },
      { kind: 'internal', target: 'outside/thing.ts', names: ['thing'], line: 10 },
      { kind: 'unresolved', target: '@root/nope/_/missing', names: ['default'], line: 11 },
      { kind: 'package', target: 'axios', declared: true, names: ['default'], line: 12 },
      { kind: 'package', target: '@nestjs/core', declared: true, names: ['Controller'], line: 13 },
      { kind: 'package', target: 'estree', declared: true, names: ['Node'], line: 14, typeOnly: true },
      { kind: 'package', target: 'react', declared: true, names: ['default'], line: 15 },
      { kind: 'package', target: 'left-pad', declared: true, names: ['default'], line: 16 },
      { kind: 'package', target: 'lodash', declared: false, names: ['map'], line: 17 },
      { kind: 'builtin', target: 'node:fs/promises', names: ['readFile'], line: 18 },
      { kind: 'builtin', target: 'path', names: ['default'], line: 19 },
      { kind: 'builtin', target: 'node:test', names: ['test'], line: 20 },
      { kind: 'relative', target: './local', names: ['local'], line: 21 },
      { kind: 'relative', target: '../up', names: ['default'], line: 22 },
      { kind: 'unresolved', target: '#internal/sub', names: ['default'], line: 23 },
      { kind: 'builtin', target: 'fs', names: ['*'], line: 24 },
      { kind: 'dynamic', target: '@root/log/_/types', line: 25 },
      { kind: 'dynamic', target: 'axios', line: 26 },
      { kind: 'dynamic', target: null, line: 28 },
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['Entry'], line: 29, typeOnly: true },
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['*'], line: 30, typeOnly: true },
      { kind: 'unresolved', target: '@root', names: ['default'], line: 31 },
    ];
    // Nothing in all.ts uses its imports; unusedNames has its own tests.
    expect(response.code['root/log/_/all.ts']!.imports.map(({ unusedNames: _u, ...entry }) => entry)).toEqual(expected);
    expect(response.config).toEqual([]);
    expect(response.dmz).toEqual({});
  });

  test('reads .tsx files and multi-line imports', async () => {
    project.write({
      'root/log/_/view.tsx': "import {\n  a,\n} from '@root/log/_/types';\nexport const View = () => <div>{a}</div>;\n",
    });
    const response = await analyze(project.dir, project.request([], ['root/log/_/view.tsx']));
    expect(response.code['root/log/_/view.tsx']!.imports).toEqual([
      { kind: 'internal', target: 'root/log/_/types.ts', names: ['a'], line: 1 },
    ]);
  });

  test('does not require packages to be installed and works without package.json', async () => {
    const bare = fixture({ 'root/a/_/x.ts': "import axios from 'axios';\nexport default axios;\n" }, { packageJson: false });
    const response = await analyze(bare.dir, bare.request([], ['root/a/_/x.ts']));
    expect(response.code['root/a/_/x.ts']!.imports).toEqual([
      { kind: 'package', target: 'axios', declared: false, names: ['default'], line: 1, unusedNames: ['default'], reexportedAs: [{ name: 'default', as: 'default' }] },
    ]);
  });

  test('an alias import is unresolved when tsconfig has no paths for it', async () => {
    const { paths: _paths, ...withoutPaths } = TSCONFIG.compilerOptions;
    const broken = fixture({ ...LOG_FILES, 'tsconfig.json': { compilerOptions: withoutPaths }, 'root/a/_/x.ts': "import { a } from '@root/log/_/types';\n" });
    const response = await analyze(broken.dir, broken.request([], ['root/a/_/x.ts']));
    expect(response.code['root/a/_/x.ts']!.imports).toEqual([{ kind: 'unresolved', target: '@root/log/_/types', names: ['a'], line: 1, unusedNames: ['a'] }]);
    expect(response.config.map((c) => c.message)).toEqual([expect.stringContaining('compilerOptions.paths has no "@root/*" entry')]);
  });
});

describe('DMZ files', () => {
  const project = fixture({
    ...LOG_FILES,
    'root/log/_/index.ts': "export { helper } from '@root/log/_/types';\n",
    'root/dmz/log/billing.ts': [
      "export { helper, a } from '@root/log/_/types';",
      "export type { Entry } from '@root/log/_/types';",
      "export { type Level } from '@root/log/_/types';",
      '',
    ].join('\n'),
    'root/billing/dmz/.parent/invoices.ts': "export { helper } from '@root/dmz/log/billing';\nexport type { Entry } from '@root/dmz/log/billing';\n",
    'root/dmz/log/viaindex.ts': "export {\n  helper,\n} from '@root/log/_/index';\n",
    'root/dmz/log/dir.ts': "export { fromIndex } from '@root/log/_/dir';\n",
    'root/dmz/log/empty.ts': '',
    'root/dmz/log/bad.ts': [
      "export * from '@root/log/_/types';",
      "export * as ns from '@root/log/_/types';",
      'export default 1;',
      'export default function f() {}',
      "export { helper as renamed } from '@root/log/_/types';",
      'export const local = 1;',
      'export interface Local {}',
      'type Hidden = string;',
      "import { a } from '@root/log/_/types';",
      'console.log(a);',
      'export { a };',
      "export { a } from './relative';",
      "export { a } from 'axios';",
      "export { a } from '@root/missing/_/x';",
      "export { nope, b } from '@root/log/_/types';",
      'enum E { A }',
      'namespace N {}',
      'function g() {}',
      'class C {}',
      '',
    ].join('\n'),
    'root/dmz/log/syntax.ts': "export { a from '@root/log/_/types';\n",
  });

  const dmzFiles = [
    'root/dmz/log/billing.ts',
    'root/billing/dmz/.parent/invoices.ts',
    'root/dmz/log/viaindex.ts',
    'root/dmz/log/dir.ts',
    'root/dmz/log/empty.ts',
    'root/dmz/log/bad.ts',
    'root/dmz/log/syntax.ts',
  ];

  test('lists each re-export with name, typeOnly, resolved from and line', async () => {
    const response = await analyze(project.dir, project.request(dmzFiles, []));
    const billing = response.dmz['root/dmz/log/billing.ts']!;
    expect(billing.violations).toEqual([]);
    expect(billing.exports.map(({ signature: _s, ...rest }) => rest)).toEqual([
      { name: 'helper', typeOnly: false, from: 'root/log/_/types.ts', line: 1 },
      { name: 'a', typeOnly: false, from: 'root/log/_/types.ts', line: 1 },
      { name: 'Entry', typeOnly: true, from: 'root/log/_/types.ts', line: 2 },
      { name: 'Level', typeOnly: true, from: 'root/log/_/types.ts', line: 3 },
    ]);
    for (const entry of billing.exports) expect(entry.signature).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('from points at the next link of a chain, and the signature is the one of the declaration', async () => {
    const response = await analyze(project.dir, project.request(dmzFiles, []));
    const billing = response.dmz['root/dmz/log/billing.ts']!.exports;
    const invoices = response.dmz['root/billing/dmz/.parent/invoices.ts']!.exports;
    const viaIndex = response.dmz['root/dmz/log/viaindex.ts']!.exports;
    const helper = billing.find((e) => e.name === 'helper')!;

    expect(invoices.map((e) => [e.name, e.from, e.typeOnly])).toEqual([
      ['helper', 'root/dmz/log/billing.ts', false],
      ['Entry', 'root/dmz/log/billing.ts', true],
    ]);
    expect(invoices[0]!.signature).toBe(helper.signature);
    expect(invoices[1]!.signature).toBe(billing.find((e) => e.name === 'Entry')!.signature);

    // A `_/` file that re-exports is a link too: from is the index, the signature is the declaration's.
    expect(viaIndex).toEqual([{ name: 'helper', typeOnly: false, from: 'root/log/_/index.ts', line: 2, signature: helper.signature }]);
    expect(response.dmz['root/dmz/log/dir.ts']!.exports[0]!.from).toBe('root/log/_/dir/index.ts');
    expect(response.dmz['root/dmz/log/empty.ts']).toEqual({ exports: [], violations: [] });
  });

  test('reports every syntax violation with its line', async () => {
    const response = await analyze(project.dir, project.request(dmzFiles, []));
    const bad = response.dmz['root/dmz/log/bad.ts']!;
    const byLine = bad.violations.map((v) => [v.line, v.message]);
    expect(byLine).toEqual([
      [1, expect.stringContaining('`export *` is not allowed')],
      [2, expect.stringContaining('`export * as` is not allowed')],
      [3, expect.stringContaining('`export default` is not allowed')],
      [4, expect.stringContaining('`export default` is not allowed')],
      [5, expect.stringContaining('renaming with `as` is not allowed')],
      [6, expect.stringContaining('declarations are not allowed')],
      [7, expect.stringContaining('declarations are not allowed')],
      [8, expect.stringContaining('declarations are not allowed')],
      [9, expect.stringContaining('`import` is not allowed')],
      [10, expect.stringContaining('only `export { ... } from`')],
      [11, expect.stringContaining('export without `from`')],
      [12, expect.stringContaining('re-export from "./relative" is not allowed')],
      [13, expect.stringContaining('re-export from "axios" is not allowed')],
      [14, expect.stringContaining('cannot resolve "@root/missing/_/x"')],
      [15, expect.stringContaining('does not export "nope"')],
      [16, expect.stringContaining('declarations are not allowed')],
      [17, expect.stringContaining('declarations are not allowed')],
      [18, expect.stringContaining('declarations are not allowed')],
      [19, expect.stringContaining('declarations are not allowed')],
    ]);
    // Valid names next to invalid ones are still reported.
    expect(bad.exports.map((e) => [e.name, e.line])).toEqual([['b', 15]]);
  });

  test('reports parse errors as violations', async () => {
    const response = await analyze(project.dir, project.request(dmzFiles, []));
    const syntax = response.dmz['root/dmz/log/syntax.ts']!;
    expect(syntax.violations.length).toBeGreaterThan(0);
    expect(syntax.violations[0]!.message).toMatch(/^syntax error: /);
    expect(syntax.violations[0]!.line).toBe(1);
  });

  test('analyzes DMZ and code files in one call', async () => {
    project.write({ 'root/billing/_/use.ts': "import { helper } from '@root/billing/dmz/.parent/invoices';\nhelper;\n" });
    const response = await analyze(project.dir, project.request(['root/billing/dmz/.parent/invoices.ts'], ['root/billing/_/use.ts']));
    expect(Object.keys(response.dmz)).toEqual(['root/billing/dmz/.parent/invoices.ts']);
    expect(response.code['root/billing/_/use.ts']!.imports).toEqual([
      { kind: 'internal', target: 'root/billing/dmz/.parent/invoices.ts', names: ['helper'], line: 1 },
    ]);
  });
});

describe('project config', () => {
  const messages = async (tsconfig: object | string, extra: Record<string, string | object> = {}) => {
    const project = fixture({ 'tsconfig.json': tsconfig, ...extra });
    const response = await analyze(project.dir, project.request([], []));
    return response.config.map((c) => {
      expect(c.file).toBe('tsconfig.json');
      return c.message;
    });
  };
  const options = TSCONFIG.compilerOptions;

  test('a correct tsconfig, with comments and trailing commas, has no problems', async () => {
    const text = `{
  // comment
  "compilerOptions": {
    "strict": true, /* inline */
    "noUnusedLocals": true,
    "paths": { "@root/*": ["./root/*"], },
  },
}
`;
    expect(await messages(text)).toEqual([]);
  });

  test('noUnusedLocals must be true', async () => {
    expect(await messages({ compilerOptions: { ...options, noUnusedLocals: false } })).toEqual([
      expect.stringContaining('noUnusedLocals must be true'),
    ]);
    const { noUnusedLocals: _n, ...withoutFlag } = options;
    expect(await messages({ compilerOptions: withoutFlag })).toEqual([expect.stringContaining('noUnusedLocals must be true')]);
  });

  test('the alias must be in paths and point to <root>/*', async () => {
    const { paths: _p, ...withoutPaths } = options;
    expect(await messages({ compilerOptions: withoutPaths })).toEqual([expect.stringContaining('has no "@root/*" entry; it must be ["./root/*"]')]);
    expect(await messages({ compilerOptions: { ...options, paths: { '@root/*': ['src/*'] } } })).toEqual([
      expect.stringContaining('compilerOptions.paths["@root/*"] is ["src/*"]; it must be ["./root/*"]'),
    ]);
    expect(await messages({ compilerOptions: { ...options, paths: { '@root/*': ['root/*', 'other/*'] } } })).toEqual([
      expect.stringContaining('compilerOptions.paths["@root/*"]'),
    ]);
  });

  test('paths are read relative to baseUrl', async () => {
    expect(await messages({ compilerOptions: { ...options, baseUrl: './src', paths: { '@root/*': ['../root/*'] } } })).toEqual([]);
    expect(await messages({ compilerOptions: { ...options, baseUrl: './src', paths: { '@root/*': ['root/*'] } } })).toEqual([
      expect.stringContaining('it must be ["../root/*"]'),
    ]);
  });

  test('settings inherited through extends count', async () => {
    expect(await messages({ extends: './tsconfig.base.json', compilerOptions: { strict: true } }, { 'tsconfig.base.json': TSCONFIG })).toEqual([]);
  });

  test('tsconfig read errors become config problems', async () => {
    const result = await messages({ extends: './missing.json', compilerOptions: options });
    expect(result).toEqual([expect.stringContaining('missing.json')]);
  });

  test('uses the alias and root from the request', async () => {
    const project = fixture({ 'tsconfig.json': { compilerOptions: { ...options, paths: { '~/*': ['./src/*'] } } }, 'src/a/_/x.ts': "import { y } from '~/a/_/y';\n", 'src/a/_/y.ts': 'export const y = 1;\n' });
    const response = await analyze(project.dir, { abi: 1, config: { ...CONFIG, root: 'src', alias: '~' }, files: { dmz: [], code: ['src/a/_/x.ts'] } });
    expect(response.config).toEqual([]);
    expect(response.code['src/a/_/x.ts']!.imports).toEqual([{ kind: 'internal', target: 'src/a/_/y.ts', names: ['y'], line: 1, unusedNames: ['y'] }]);
  });
});

describe('build folders', () => {
  const options = TSCONFIG.compilerOptions;
  const messages = async (files: Record<string, string | object>, nestedProjects?: string[]) => {
    const project = fixture(files);
    const request = project.request([], []);
    if (nestedProjects !== undefined) request.nestedProjects = nestedProjects;
    const response = await analyze(project.dir, request);
    return response.config.map((c) => `${c.file}: ${c.message}`);
  };

  test('the root folder must be in the build', async () => {
    expect(await messages({ 'tsconfig.json': { compilerOptions: options, include: ['root'] } })).toEqual([]);
    expect(await messages({ 'tsconfig.json': { compilerOptions: options, include: ['src'] } })).toEqual([
      'tsconfig.json: The effective "include" and "files" of tsconfig.json (after "extends") do not reach root/, so the TypeScript build leaves the bucket code out. Add "root" to "include" in tsconfig.json',
    ]);
    expect(await messages({ 'tsconfig.json': { compilerOptions: options, include: ['root'], exclude: ['root'] } })).toEqual([
      expect.stringContaining('The effective "exclude" of tsconfig.json (after "extends") leaves root/ out'),
    ]);
  });

  test('"files" alone counts when it lists a file of the root folder', async () => {
    expect(await messages({ 'tsconfig.json': { compilerOptions: options, files: ['root/_/main.ts'] }, 'root/_/main.ts': 'export {};\n' })).toEqual([]);
    expect(await messages({ 'tsconfig.json': { compilerOptions: options, files: ['other.ts'] }, 'other.ts': 'export {};\n' })).toEqual([
      expect.stringContaining('do not reach root/'),
    ]);
  });

  test('"include" and "exclude" inherited through extends count, relative to the config that declares them', async () => {
    const base = { compilerOptions: { ...options, paths: { '@root/*': ['../root/*'] } }, include: ['../root'] };
    expect(await messages({ 'tsconfig.json': { extends: './configs/base.json' }, 'configs/base.json': base })).toEqual([]);
    expect(await messages({ 'tsconfig.json': { extends: './configs/base.json' }, 'configs/base.json': { ...base, include: ['../src'] } })).toEqual([
      expect.stringContaining('do not reach root/'),
    ]);
  });

  test('rootDir must contain the root folder', async () => {
    expect(await messages({ 'tsconfig.json': { compilerOptions: { ...options, rootDir: '.' } } })).toEqual([]);
    expect(await messages({ 'tsconfig.json': { compilerOptions: { ...options, rootDir: './root' } } })).toEqual([]);
    expect(await messages({ 'tsconfig.json': { compilerOptions: { ...options, rootDir: './src' } } })).toEqual([
      'tsconfig.json: compilerOptions.rootDir is "src", which does not contain root/, so TypeScript rejects the bucket files (error TS6059). Set "rootDir" in tsconfig.json to a folder that contains root/, such as ".", or remove it',
    ]);
  });

  test('a nested project must be out of the build', async () => {
    const nested = ['root/log/_/engine'];
    expect(await messages({ 'tsconfig.json': { compilerOptions: options } })).toEqual([]);
    expect(await messages({ 'tsconfig.json': { compilerOptions: options } }, nested)).toEqual([
      'tsconfig.json: The effective "include" of tsconfig.json reaches the nested project root/log/_/engine, so the TypeScript build of this project also compiles the files of that project, with the settings and alias of this one. Add "root/log/_/engine" to "exclude" in tsconfig.json',
    ]);
    expect(await messages({ 'tsconfig.json': { compilerOptions: options, include: ['root'] } }, nested)).toEqual([expect.stringContaining('reaches the nested project')]);
    for (const exclude of ['root/log/_/engine', './root/log/_/engine/', 'root/log/_/engine/**', 'root/**/engine', 'root/*/_']) {
      expect(await messages({ 'tsconfig.json': { compilerOptions: options, include: ['root'], exclude: [exclude] } }, nested)).toEqual([]);
    }
    expect(
      await messages(
        {
          'tsconfig.json': { compilerOptions: options, files: ['root/_/main.ts', 'root/log/_/engine/root/_/run.ts'] },
          'root/_/main.ts': 'export {};\n',
          'root/log/_/engine/root/_/run.ts': 'export {};\n',
        },
        nested,
      ),
    ).toEqual([expect.stringContaining('The "files" of tsconfig.json list files of the nested project root/log/_/engine')]);
    // Only the folders the request names are checked.
    expect(await messages({ 'tsconfig.json': { compilerOptions: options, include: ['root'] } }, [])).toEqual([]);
  });
});

describe('environment errors', () => {
  test('no tsconfig.json', async () => {
    const project = fixture({}, { tsconfig: false });
    await expect(analyze(project.dir, project.request([], []))).rejects.toMatchObject({ name: 'AdapterEnvironmentError', code: 'no-tsconfig' });
  });

  test('no typescript package', async () => {
    // Outside the repository, so that the repository's typescript cannot be found.
    const base = mkdtempSync(path.join(os.tmpdir(), 'slopbuckets-adapter-'));
    try {
      const project = new Fixture({}, { base });
      const error = await analyze(project.dir, project.request([], [])).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterEnvironmentError);
      expect(error).toMatchObject({ code: 'no-typescript' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a requested file that does not exist fails the adapter', async () => {
    const project = fixture({});
    await expect(analyze(project.dir, project.request([], ['root/a/_/gone.ts']))).rejects.toMatchObject({ code: 'adapter-failed' });
  });

  test('a different protocol version fails the adapter', async () => {
    const project = fixture({});
    await expect(analyze(project.dir, { ...project.request([], []), abi: 2 })).rejects.toMatchObject({ code: 'adapter-failed' });
  });
});

describe('inputs', () => {
  test('lists the tsconfig extends chain, package.json, .d.ts files outside the root and the lib files it read', async () => {
    const project = fixture({
      'tsconfig.base.json': { compilerOptions: { strict: true } },
      'tsconfig.json': { ...TSCONFIG, extends: './tsconfig.base.json' },
      'types/env.d.ts': 'export interface Env { name: string }\n',
      'root/log/_/a.ts': "import type { Env } from '../../../types/env';\nimport { b } from './b';\nexport const a = (env: Env): number => b + env.name.length;\n",
      'root/log/_/b.ts': 'export const b = 1;\n',
    });
    const response = await analyze(project.dir, project.request([], ['root/log/_/a.ts']));
    const inputs = response.inputs ?? [];
    expect(inputs).toContain('tsconfig.json');
    expect(inputs).toContain('tsconfig.base.json');
    expect(inputs).toContain('package.json');
    expect(inputs).toContain('root/log/_/a.ts');
    expect(inputs).toContain('root/log/_/b.ts');
    expect(inputs).toContain('types/env.d.ts');
    // Files outside the project, such as the TypeScript lib files, are listed by absolute path.
    expect(inputs.some((i) => path.isAbsolute(i) && /lib\.[a-z0-9.]*d\.ts$/i.test(i))).toBe(true);
    expect([...inputs].sort()).toEqual(inputs);
    expect(new Set(inputs).size).toBe(inputs.length);
  });
});


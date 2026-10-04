// Tests for code-file analysis: globals, JavaScript files, require through other
// names, unused and re-exported imports, symlinks and `file:` packages, BOMs.

import { mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadTypeScript } from './env.js';
import { analyze, info, type AnalyzeResponse, type ImportEntry } from './index.js';
import { Fixture, TSCONFIG } from './test-fixture.js';

const fixtures: Fixture[] = [];
const links: string[] = [];
function fixture(...args: ConstructorParameters<typeof Fixture>): Fixture {
  const created = new Fixture(...args);
  fixtures.push(created);
  return created;
}
afterAll(() => {
  // Remove links first, so that removing a fixture never walks into the link target.
  for (const link of links) {
    try {
      unlinkSync(link);
    } catch {
      // already gone
    }
  }
  for (const created of fixtures) created.remove();
});

/** Creates a directory link (a junction on Windows). Returns false when the system does not allow it. */
function linkDir(target: string, link: string): boolean {
  mkdirSync(path.dirname(link), { recursive: true });
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') return false;
    throw error;
  }
  links.push(link);
  return true;
}

async function code(project: Fixture, files: string[]): Promise<AnalyzeResponse['code']> {
  return (await analyze(project.dir, project.request([], files))).code;
}

const dynamicLines = (imports: ImportEntry[]) => imports.filter((i) => i.kind === 'dynamic').map((i) => [i.line, i.target]);

describe('globals', () => {
  test('a _/ file that is not a module shares its declarations globally', async () => {
    const project = fixture({
      'root/a/_/secret.ts': 'function secretFromA(): number {\n  return 1;\n}\nif (true) { var leaked = 2; }\n',
      'root/b/_/use.ts': 'export const value = secretFromA() + leaked;\n',
    });
    const result = await code(project, ['root/a/_/secret.ts', 'root/b/_/use.ts']);
    expect(result['root/a/_/secret.ts']!.globals).toEqual([{ line: 1, message: expect.stringContaining('(secretFromA, leaked) are global') }]);
    expect(result['root/b/_/use.ts']!.globals).toBeUndefined();
  });

  test('declare global blocks are reported, inside modules too', async () => {
    const project = fixture({
      'root/a/_/service.ts': [
        'export {};',
        'declare global {',
        '  var aService: { run(): void };',
        '  interface AInvoice { id: string }',
        '}',
        "declare module 'some-package' {",
        '  global { const nested: number; }',
        '}',
        '',
      ].join('\n'),
    });
    const result = await code(project, ['root/a/_/service.ts']);
    expect(result['root/a/_/service.ts']!.globals).toEqual([
      { line: 2, message: expect.stringContaining('`declare global`') },
      { line: 7, message: expect.stringContaining('`declare global`') },
    ]);
  });

  test('triple-slash path and types references are reported; lib references are not', async () => {
    const project = fixture({
      'root/a/_/secret.ts': 'export const s = 1;\n',
      'root/b/_/use.ts': '/// <reference path="../../a/_/secret.ts" />\n/// <reference types="node" />\n/// <reference lib="es2022" />\nexport const x = 1;\n',
    });
    const result = await code(project, ['root/b/_/use.ts']);
    expect(result['root/b/_/use.ts']!.globals).toEqual([
      { line: 1, message: expect.stringContaining('<reference path="../../a/_/secret.ts" />') },
      { line: 2, message: expect.stringContaining('<reference types="node" />') },
    ]);
  });

  test('modules, side-effect scripts and ambient module declarations share nothing', async () => {
    const project = fixture({
      'root/a/_/module.ts': 'const local = 1;\nexport const value = local;\n',
      'root/a/_/side.ts': 'console.log("loaded");\n',
      'root/a/_/empty.ts': '',
      'root/a/_/pino.d.ts': "declare module 'pino' {\n  export default function pino(): void;\n}\n",
    });
    const files = ['root/a/_/module.ts', 'root/a/_/side.ts', 'root/a/_/empty.ts', 'root/a/_/pino.d.ts'];
    const result = await code(project, files);
    for (const file of files) expect(result[file]!.globals, file).toBeUndefined();
  });

  test('a declaration file without imports or exports is global', async () => {
    const project = fixture({ 'root/a/_/types.d.ts': 'interface AInvoice { id: string }\n' });
    const result = await code(project, ['root/a/_/types.d.ts']);
    expect(result['root/a/_/types.d.ts']!.globals).toEqual([{ line: 1, message: expect.stringContaining('(AInvoice)') }]);
  });

  test('moduleDetection force makes every file a module', async () => {
    const project = fixture({
      'tsconfig.json': { compilerOptions: { ...TSCONFIG.compilerOptions, moduleDetection: 'force' } },
      'root/a/_/secret.ts': 'function secretFromA(): number { return 1; }\n',
    });
    expect((await code(project, ['root/a/_/secret.ts']))['root/a/_/secret.ts']!.globals).toBeUndefined();
  });
});

describe('typeOnly', () => {
  test('is true only when the whole statement is type-only', async () => {
    const project = fixture({
      'root/b/_/t.ts': 'export interface A { a: 1 }\nexport interface B { b: 1 }\nexport const v = 1;\n',
      'root/a/_/use.ts': [
        "import type { A } from '@root/b/_/t';",
        "import { type B } from '@root/b/_/t';",
        "import { v } from '@root/b/_/t';",
        "export type { A as A2 } from '@root/b/_/t';",
        "export { v as v2 } from '@root/b/_/t';",
        "type C = import('@root/b/_/t').A;",
        'export const x: A | B | C | number = v;',
        '',
      ].join('\n'),
    });
    const imports = (await code(project, ['root/a/_/use.ts']))['root/a/_/use.ts']!.imports;
    expect(imports.map((i) => [i.line, i.typeOnly === true])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, true],
      [5, false],
      [6, true],
    ]);
  });
});

describe('JavaScript files', () => {
  test('the adapter claims JavaScript extensions', () => {
    expect(info().extensions).toEqual(expect.arrayContaining(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']));
  });

  const project = fixture({
    'root/b/_/secret.ts': 'export const secret = 1;\nexport interface Secret { id: string }\n',
    'root/b/_/other.ts': 'export interface Other { id: number }\n',
    'root/a/_/bridge.js': "import { secret } from '@root/b/_/secret';\nexport const copy = secret;\n",
    'root/a/_/legacy.cjs': "const s = require('@root/b/_/secret');\nmodule.exports = s;\n",
    'root/a/_/view.jsx': "import { secret } from '@root/b/_/secret';\nexport const View = () => <div>{secret}</div>;\n",
    'root/a/_/esm.mjs': "export { secret } from '@root/b/_/secret';\n",
    'root/a/_/jsdoc.js': [
      "/** @import { Secret } from '@root/b/_/secret' */",
      '',
      "/** @type {import('@root/b/_/other').Other | undefined} */",
      'export let other;',
      '',
      '/** @param {Secret} s */',
      'export function f(s) { return s; }',
      '',
    ].join('\n'),
    'root/a/_/script.js': 'function helper() { return 1; }\n',
    'root/a/_/commonjs.js': 'const x = 1;\nmodule.exports = { x };\n',
  });

  test('imports, require calls and re-exports are reported like in TypeScript files', async () => {
    const result = await code(project, ['root/a/_/bridge.js', 'root/a/_/legacy.cjs', 'root/a/_/view.jsx', 'root/a/_/esm.mjs']);
    expect(result['root/a/_/bridge.js']!.imports).toEqual([{ kind: 'internal', target: 'root/b/_/secret.ts', names: ['secret'], line: 1 }]);
    expect(result['root/a/_/legacy.cjs']!.imports).toEqual([{ kind: 'dynamic', target: '@root/b/_/secret', line: 1 }]);
    expect(result['root/a/_/view.jsx']!.imports).toEqual([{ kind: 'internal', target: 'root/b/_/secret.ts', names: ['secret'], line: 1 }]);
    expect(result['root/a/_/esm.mjs']!.imports).toEqual([
      { kind: 'internal', target: 'root/b/_/secret.ts', names: ['secret'], line: 1, reexport: true, reexportedAs: [{ name: 'secret', as: 'secret' }] },
    ]);
  });

  test('JSDoc @import tags and import() types are imports, and JSDoc types count as uses', async () => {
    const result = await code(project, ['root/a/_/jsdoc.js']);
    expect(result['root/a/_/jsdoc.js']!.imports).toEqual([
      { kind: 'internal', target: 'root/b/_/secret.ts', names: ['Secret'], line: 1, typeOnly: true },
      { kind: 'internal', target: 'root/b/_/other.ts', names: ['Other'], line: 3, typeOnly: true },
    ]);
  });

  test('a JavaScript script is global; a CommonJS file is not', async () => {
    const result = await code(project, ['root/a/_/script.js', 'root/a/_/commonjs.js']);
    expect(result['root/a/_/script.js']!.globals).toEqual([{ line: 1, message: expect.stringContaining('(helper)') }]);
    expect(result['root/a/_/commonjs.js']!.globals).toBeUndefined();
  });

  test('upper-case extensions load, even where file names are case-sensitive', async () => {
    const upper = fixture({
      'root/b/_/secret.ts': 'export const secret = 1;\n',
      'root/a/_/Legacy.TS': "import { secret } from '@root/b/_/secret';\nexport const copy = secret;\n",
      'root/a/_/Old.JS': "import { secret } from './relative';\nexport const copy = secret;\n",
    });
    const ts = loadTypeScript(upper.dir);
    const sys = ts.sys as { useCaseSensitiveFileNames: boolean };
    const original = sys.useCaseSensitiveFileNames;
    // Linux behaviour on any machine: the compiler host reads this flag when it is created.
    sys.useCaseSensitiveFileNames = true;
    try {
      const result = await code(upper, ['root/a/_/Legacy.TS', 'root/a/_/Old.JS']);
      expect(result['root/a/_/Legacy.TS']!.imports).toEqual([{ kind: 'internal', target: 'root/b/_/secret.ts', names: ['secret'], line: 1 }]);
      expect(result['root/a/_/Old.JS']!.imports).toEqual([{ kind: 'relative', target: './relative', names: ['secret'], line: 1 }]);
    } finally {
      sys.useCaseSensitiveFileNames = original;
    }
  });
});

describe('require through other names', () => {
  test('createRequire, module.require and loose uses of require are dynamic', async () => {
    const project = fixture({
      'root/a/_/loader.ts': [
        "import { createRequire } from 'node:module';",
        "import * as nodeModule from 'module';",
        'const req = createRequire(import.meta.url);',
        "const a = req('@root/b/_/secret');",
        'const r = require;',
        "const b = module.require('x');",
        "const c = nodeModule.createRequire(import.meta.url)('y');",
        'const { createRequire: cr } = nodeModule;',
        "const d = require.resolve('z');",
        "export { createRequire as again } from 'node:module';",
        "const e = nodeModule['createRequire'];",
        'export { a, b, c, cr, d, e, r };',
        '',
      ].join('\n'),
    });
    const result = await code(project, ['root/a/_/loader.ts']);
    const imports = result['root/a/_/loader.ts']!.imports;
    expect(dynamicLines(imports)).toEqual([
      [1, null],
      [4, '@root/b/_/secret'],
      [5, null],
      [6, 'x'],
      // The outer call comes first in the tree.
      [7, 'y'],
      [7, null],
      [8, null],
      [9, null],
      [10, null],
      [11, null],
    ]);
    // The builtin imports are still reported as such.
    expect(imports.filter((i) => i.kind === 'builtin').map((i) => [i.line, i.target])).toEqual([
      [1, 'node:module'],
      [2, 'module'],
      [10, 'node:module'],
    ]);
  });

  test('names that only look like require are not dynamic', async () => {
    const project = fixture({
      'root/a/_/plain.ts': [
        'declare function require(id: string): unknown;',
        'const options = { require: true };',
        'const holder = { require: (id: string) => id };',
        "export const v = holder.require('x');",
        'type R = typeof require;',
        'export const w: R | undefined = undefined;',
        'export { options };',
        "import fs = require('fs');",
        'export const read = fs.readFileSync;',
        '',
      ].join('\n'),
    });
    const result = await code(project, ['root/a/_/plain.ts']);
    expect(dynamicLines(result['root/a/_/plain.ts']!.imports)).toEqual([]);
  });
});

describe('unused imports and re-exports', () => {
  const LIB = {
    'root/x/_/lib.ts': 'export const a = 1, b = 2, c = 3, e = 5, f = 6, g = 7, k = 8;\nexport interface T { n: number }\n',
    'root/x/_/def.ts': 'export default function def(): void {}\n',
  };

  test('names that the file never references are listed in unusedNames', async () => {
    const project = fixture({
      ...LIB,
      'root/y/_/use.ts': [
        "import { a, b as renamed, c } from '@root/x/_/lib';",
        "import type { T } from '@root/x/_/lib';",
        "import * as unusedNs from '@root/x/_/lib';",
        "import * as usedNs from '@root/x/_/lib';",
        "import def from '@root/x/_/def';",
        "import { e } from '@root/x/_/lib';",
        "import { f } from '@root/x/_/lib';",
        "import { g } from '@root/x/_/lib';",
        "import '@root/x/_/def';",
        'export const used = a + usedNs.b;',
        'export let typed: T | undefined;',
        'export type C = typeof c;',
        'export const object = { def };',
        'export { e };',
        'export default f;',
        'export function shadow(g: number): number { return g; }',
        '',
      ].join('\n'),
    });
    const result = await code(project, ['root/y/_/use.ts']);
    const byLine = Object.fromEntries(result['root/y/_/use.ts']!.imports.map((i) => [i.line, i.unusedNames]));
    expect(byLine).toEqual({
      1: ['b'],
      2: undefined,
      3: ['*'],
      4: undefined,
      5: undefined,
      // Re-exporting an imported name is not a use.
      6: ['e'],
      7: ['f'],
      // A parameter with the same name shadows the import.
      8: ['g'],
      9: undefined,
    });
  });

  test('export ... from is marked as a re-export', async () => {
    const project = fixture({
      ...LIB,
      'root/y/_/barrel.ts': "export { a } from '@root/x/_/lib';\nexport * from '@root/x/_/lib';\nexport * as all from '@root/x/_/lib';\nexport type { T } from '@root/x/_/lib';\n",
    });
    const result = await code(project, ['root/y/_/barrel.ts']);
    expect(result['root/y/_/barrel.ts']!.imports.map((i) => [i.names, i.reexport, i.unusedNames])).toEqual([
      [['a'], true, undefined],
      [['*'], true, undefined],
      [['*'], true, undefined],
      [['T'], true, undefined],
    ]);
  });

  test('the classic JSX factory counts as a use', async () => {
    const project = fixture({
      'root/x/_/react.ts': 'export default { createElement: () => null };\n',
      'root/y/_/view.tsx': "import React from '@root/x/_/react';\nexport const View = () => <div />;\n",
    });
    const result = await code(project, ['root/y/_/view.tsx']);
    expect(result['root/y/_/view.tsx']!.imports[0]!.unusedNames).toBeUndefined();
  });
});

describe('symlinks and file: packages', () => {
  test('an alias import through a junction inside _/ resolves to the real file', async (context) => {
    const project = fixture({
      'root/a/_/secret.ts': 'export const s = 1;\n',
      'root/b/_/use.ts': "import { s } from '@root/b/_/link/secret';\nexport const copy = s;\n",
      'root/dmz/b/.self.ts': "export { s } from '@root/b/_/link/secret';\n",
    });
    if (!linkDir(path.join(project.dir, 'root/a/_'), path.join(project.dir, 'root/b/_/link'))) context.skip();
    const response = await analyze(project.dir, project.request(['root/dmz/b/.self.ts'], ['root/b/_/use.ts']));
    expect(response.code['root/b/_/use.ts']!.imports).toEqual([{ kind: 'internal', target: 'root/a/_/secret.ts', names: ['s'], line: 1 }]);
    expect(response.dmz['root/dmz/b/.self.ts']!.exports.map((e) => e.from)).toEqual(['root/a/_/secret.ts']);
  });

  test('an import through a buckets link to another project resolves to the path through the link', async (context) => {
    const origin = fixture({ 'index.d.ts': 'export interface User {\n  id: string;\n}\n' }, { tsconfig: false, packageJson: false });
    const project = fixture({
      'root/b/_/use.ts': "import type { User } from '@root/b/_/links/api';\nexport const none: User | undefined = undefined;\n",
      'root/b/_/peek.ts': "import type { User } from '@root/b/_/elsewhere';\nexport const none: User | undefined = undefined;\n",
    });
    if (!linkDir(origin.dir, path.join(project.dir, 'root/b/_/links/api'))) context.skip();
    if (!linkDir(origin.dir, path.join(project.dir, 'root/b/_/elsewhere'))) context.skip();
    const result = await code(project, ['root/b/_/use.ts', 'root/b/_/peek.ts']);
    expect(result['root/b/_/use.ts']!.imports).toEqual([
      { kind: 'internal', target: 'root/b/_/links/api/index.d.ts', names: ['User'], line: 1, typeOnly: true },
    ]);
    // Only `<bucket>/_/links/<name>` counts as a link; any other symlink that leaves the project stays unresolved.
    expect(result['root/b/_/peek.ts']!.imports[0]!.kind).toBe('unresolved');
  });

  test('a package linked into node_modules that lands in the root folder is internal', async (context) => {
    const project = fixture({
      'package.json': { name: 'fixture', dependencies: { 'shared-a': 'file:./root/a/_', 'shared-ext': 'file:./outside' } },
      'root/a/_/secret.ts': 'export const s = 1;\n',
      'outside/thing.ts': 'export const t = 1;\n',
      'root/b/_/use.ts': "import { s } from 'shared-a/secret';\nimport { t } from 'shared-ext/thing';\nexport const copy = s + t;\n",
    });
    if (!linkDir(path.join(project.dir, 'root/a/_'), path.join(project.dir, 'node_modules/shared-a'))) context.skip();
    if (!linkDir(path.join(project.dir, 'outside'), path.join(project.dir, 'node_modules/shared-ext'))) context.skip();
    const result = await code(project, ['root/b/_/use.ts']);
    expect(result['root/b/_/use.ts']!.imports).toEqual([
      { kind: 'internal', target: 'root/a/_/secret.ts', names: ['s'], line: 1 },
      { kind: 'package', target: 'shared-ext', declared: true, names: ['t'], line: 2 },
    ]);
  });

  test('an installed package stays a package when the root folder is the project folder', async () => {
    const project = fixture({
      'node_modules/real-pkg/package.json': { name: 'real-pkg', version: '1.0.0', types: 'index.d.ts' },
      'node_modules/real-pkg/index.d.ts': 'export declare const r: number;\n',
      'a/_/use.ts': "import { r } from 'real-pkg';\nexport const copy = r;\n",
    });
    const response = await analyze(project.dir, { abi: 1, config: { root: '.', alias: '@root', maxDepth: 2 }, files: { dmz: [], code: ['a/_/use.ts'] } });
    expect(response.code['a/_/use.ts']!.imports).toEqual([{ kind: 'package', target: 'real-pkg', declared: false, names: ['r'], line: 1 }]);
  });

  test('a paths entry that maps a bare specifier into the root folder is internal', async () => {
    const project = fixture({
      'tsconfig.json': { compilerOptions: { ...TSCONFIG.compilerOptions, paths: { ...TSCONFIG.compilerOptions.paths, shared: ['./root/a/_/secret.ts'] } } },
      'root/a/_/secret.ts': 'export const s = 1;\n',
      'root/b/_/use.ts': "import { s } from 'shared';\nexport const copy = s;\n",
    });
    const result = await code(project, ['root/b/_/use.ts']);
    expect(result['root/b/_/use.ts']!.imports).toEqual([{ kind: 'internal', target: 'root/a/_/secret.ts', names: ['s'], line: 1 }]);
  });
});

describe('package.json and toolchain', () => {
  test('a package.json with a UTF-8 BOM is read', async () => {
    const project = fixture({
      'package.json': `﻿${JSON.stringify({ name: 'bom', dependencies: { axios: '1' } })}`,
      'root/a/_/x.ts': "import axios from 'axios';\nexport const client = axios;\n",
    });
    const response = await analyze(project.dir, project.request([], ['root/a/_/x.ts']));
    expect(response.config).toEqual([]);
    expect(response.code['root/a/_/x.ts']!.imports).toEqual([{ kind: 'package', target: 'axios', declared: true, names: ['default'], line: 1 }]);
  });

  test('an unreadable package.json is a config problem', async () => {
    const project = fixture({ 'package.json': '{ "dependencies": ' });
    const response = await analyze(project.dir, project.request([], []));
    expect(response.config).toEqual([{ file: 'package.json', message: expect.stringContaining('package.json is not valid JSON') }]);
  });

  test('the response names the TypeScript version that computed the signatures', async () => {
    const project = fixture({});
    const response = await analyze(project.dir, project.request([], []));
    expect(response.toolchain).toBe(`typescript@${loadTypeScript(project.dir).version}`);
  });
});

describe('local re-exports', () => {
  test('reexportedAs lists the imported names that the file exports again, with their exported names', async () => {
    const project = fixture({
      'root/x/_/lib.ts': 'export const a = 1, b = 2, c = 3;\n',
      'root/y/_/barrel.ts': [
        "import { a } from '@root/x/_/lib';",
        "import * as ns from '@root/x/_/lib';",
        "import { c } from '@root/x/_/lib';",
        "export { b as renamed } from '@root/x/_/lib';",
        "export * as all from '@root/x/_/lib';",
        "export * from '@root/x/_/lib';",
        'export { a, a as alsoA, ns };',
        'export default a;',
        'export const copy = c;',
        '',
      ].join('\n'),
    });
    const imports = (await code(project, ['root/y/_/barrel.ts']))['root/y/_/barrel.ts']!.imports;
    expect(imports.map((i) => [i.line, i.unusedNames, i.reexportedAs])).toEqual([
      [
        1,
        ['a'],
        [
          { name: 'a', as: 'a' },
          { name: 'a', as: 'alsoA' },
          { name: 'a', as: 'default' },
        ],
      ],
      [2, ['*'], [{ name: '*', as: 'ns' }]],
      // `c` is used, and not exported again.
      [3, undefined, undefined],
      [4, undefined, [{ name: 'b', as: 'renamed' }]],
      [5, undefined, [{ name: '*', as: 'all' }]],
      [6, undefined, [{ name: '*', as: '*' }]],
    ]);
  });
});

describe('declare module and export as namespace', () => {
  const TYPES = { 'root/b/_/types.ts': 'export interface Shape { id: string }\nexport const real = 1;\n' };

  test('a module augmentation of project code is an import', async () => {
    const project = fixture({
      ...TYPES,
      'root/a/_/augment.ts': "export {};\ndeclare module '@root/b/_/types' {\n  interface Shape { injected: string }\n}\n",
      'root/a/_/relative.ts': "export {};\ndeclare module '../../b/_/types' {\n  interface Shape { other: string }\n}\n",
    });
    const result = await code(project, ['root/a/_/augment.ts', 'root/a/_/relative.ts']);
    expect(result['root/a/_/augment.ts']).toEqual({ imports: [{ kind: 'internal', target: 'root/b/_/types.ts', names: [], line: 2 }] });
    expect(result['root/a/_/relative.ts']).toEqual({ imports: [{ kind: 'relative', target: '../../b/_/types', line: 2 }] });
  });

  test('an ambient module in a script that takes over a project specifier is an import, not a global', async () => {
    const project = fixture({
      ...TYPES,
      'root/a/_/hijack.d.ts': "declare module '@root/b/_/types' {\n  export const fromA: string;\n}\n",
      'root/a/_/paths.d.ts': "declare module 'shared-types' {\n  export const fromA: string;\n}\n",
      'tsconfig.json': { compilerOptions: { ...TSCONFIG.compilerOptions, paths: { ...TSCONFIG.compilerOptions.paths, 'shared-types': ['./root/b/_/types.ts'] } } },
    });
    const result = await code(project, ['root/a/_/hijack.d.ts', 'root/a/_/paths.d.ts']);
    expect(result['root/a/_/hijack.d.ts']).toEqual({ imports: [{ kind: 'internal', target: 'root/b/_/types.ts', names: [], line: 1 }] });
    expect(result['root/a/_/paths.d.ts']).toEqual({ imports: [{ kind: 'internal', target: 'root/b/_/types.ts', names: [], line: 1 }] });
  });

  test('package augmentations and pattern declarations are not imports', async () => {
    const project = fixture({
      'root/a/_/augment.ts': "export {};\ndeclare module 'axios' {\n  interface AxiosRequestConfig { traceId?: string }\n}\n",
      'root/a/_/assets.d.ts': "declare module '*.svg' {\n  const url: string;\n  export default url;\n}\n",
    });
    const result = await code(project, ['root/a/_/augment.ts', 'root/a/_/assets.d.ts']);
    expect(result['root/a/_/augment.ts']).toEqual({ imports: [] });
    expect(result['root/a/_/assets.d.ts']).toEqual({ imports: [] });
  });

  test('export as namespace is reported as a global', async () => {
    const project = fixture({ 'root/b/_/api.d.ts': 'export interface Secret { value: string }\nexport as namespace BApi;\n' });
    const result = await code(project, ['root/b/_/api.d.ts']);
    expect(result['root/b/_/api.d.ts']!.globals).toEqual([{ line: 2, message: expect.stringContaining('`export as namespace BApi`') }]);
  });
});

describe('ambient declaration files', () => {
  const MOVE = 'Move ambient declaration files out of the root folder, for example to a `types/` folder';

  test('ambient scripts and declaration files get the advice to move them out of the root folder', async () => {
    const project = fixture({
      'root/_/define.ts': 'declare const __APP_VERSION__: string;\n',
      'root/_/express.d.ts': 'declare namespace Express {\n  interface Request { user?: string }\n}\n',
      'root/_/vite-env.d.ts': '/// <reference types="vite/client" />\n',
      'root/_/global.d.ts': 'export {};\ndeclare global {\n  const __BUILD__: string;\n}\n',
    });
    const files = ['root/_/define.ts', 'root/_/express.d.ts', 'root/_/vite-env.d.ts', 'root/_/global.d.ts'];
    const result = await code(project, files);
    for (const file of files) {
      const globals = result[file]!.globals ?? [];
      expect(globals, file).toHaveLength(1);
      expect(globals[0]!.message, file).toContain(MOVE);
      expect(globals[0]!.message, file).not.toContain('make it a module');
    }
  });

  test('a script with code still gets the advice to become a module', async () => {
    const project = fixture({ 'root/_/script.ts': 'function helper(): number { return 1; }\n' });
    const message = (await code(project, ['root/_/script.ts']))['root/_/script.ts']!.globals![0]!.message;
    expect(message).toContain('to make it a module');
    expect(message).not.toContain(MOVE);
  });
});

describe('specifiers TypeScript does not resolve', () => {
  test('an alias import of an asset maps to the file under the root folder', async () => {
    const project = fixture({
      'root/_/logo.svg': '<svg/>\n',
      'root/_/app.css': 'body {}\n',
      'root/_/assets.d.ts': "declare module '*.svg' {\n  const url: string;\n  export default url;\n}\ndeclare module '*.css';\ndeclare module '*.svg?raw';\n",
      'root/_/main.ts': [
        "import logo from '@root/_/logo.svg';",
        "import '@root/_/app.css';",
        "import raw from '@root/_/logo.svg?raw';",
        "import missing from '@root/_/missing.svg';",
        'export const all = [logo, raw, missing];',
        '',
      ].join('\n'),
    });
    const imports = (await code(project, ['root/_/main.ts']))['root/_/main.ts']!.imports;
    expect(imports).toEqual([
      { kind: 'internal', target: 'root/_/logo.svg', names: ['default'], line: 1 },
      { kind: 'internal', target: 'root/_/app.css', names: [], line: 2 },
      { kind: 'internal', target: 'root/_/logo.svg', names: ['default'], line: 3 },
      { kind: 'unresolved', target: '@root/_/missing.svg', names: ['default'], line: 4 },
    ]);
  });

  test('a paths entry that leads outside the root folder is internal with that path', async () => {
    const project = fixture({
      'tsconfig.json': { compilerOptions: { ...TSCONFIG.compilerOptions, paths: { ...TSCONFIG.compilerOptions.paths, '#shared/*': ['./shared/*'] } } },
      'shared/s.ts': 'export const s = 1;\n',
      'root/a/_/use.ts': "import { s } from '#shared/s';\nexport const copy = s;\n",
    });
    const imports = (await code(project, ['root/a/_/use.ts']))['root/a/_/use.ts']!.imports;
    expect(imports).toEqual([{ kind: 'internal', target: 'shared/s.ts', names: ['s'], line: 1 }]);
  });

  test('a paths entry named like a builtin is resolved before the builtin test', async () => {
    const project = fixture({
      'tsconfig.json': { compilerOptions: { ...TSCONFIG.compilerOptions, paths: { ...TSCONFIG.compilerOptions.paths, crypto: ['./root/b/_/secret.ts'] } } },
      'root/b/_/secret.ts': 'export const secret = 1;\n',
      'root/a/_/use.ts': "import { secret } from 'crypto';\nimport { readFile } from 'node:fs';\nexport const copy = [secret, readFile];\n",
    });
    const imports = (await code(project, ['root/a/_/use.ts']))['root/a/_/use.ts']!.imports;
    expect(imports).toEqual([
      { kind: 'internal', target: 'root/b/_/secret.ts', names: ['secret'], line: 1 },
      { kind: 'builtin', target: 'node:fs', names: ['readFile'], line: 2 },
    ]);
  });
});

describe('code loading outside import statements', () => {
  test('import.meta.glob and the Module loader are dynamic', async () => {
    const project = fixture({
      'root/a/_/load.ts': [
        "import Module from 'node:module';",
        "const pages = import.meta.glob('./pages/*.ts');",
        'const glob = import.meta.glob;',
        "const viaConstructor = (module as any).constructor._load('x');",
        'const load = (Module as any)._load;',
        "const indexed = (Module as any)['_compile'];",
        'export const all = [pages, glob, viaConstructor, load, indexed];',
        '',
      ].join('\n'),
      'root/a/_/types.d.ts': 'interface ImportMeta { glob(pattern: string): Record<string, unknown> }\ndeclare const module: unknown;\n',
    });
    const imports = (await code(project, ['root/a/_/load.ts']))['root/a/_/load.ts']!.imports;
    expect(dynamicLines(imports)).toEqual([
      [2, './pages/*.ts'],
      [3, null],
      [4, null],
      [5, null],
      [6, null],
    ]);
  });

  test('new URL with import.meta.url and test mocking helpers are imports of their string', async () => {
    const project = fixture({
      'root/b/_/secret.ts': 'export const secret = 1;\n',
      'root/a/_/own.ts': 'export const own = 1;\n',
      'root/a/_/test.ts': [
        'declare const vi: any, jest: any;',
        "vi.mock('@root/a/_/own');",
        "vi.mock('@root/b/_/secret');",
        "const actual = vi.importActual('axios');",
        "jest.requireActual('@root/b/_/secret');",
        "const worker = new URL('./worker.ts', import.meta.url);",
        "const remote = new URL('https://example.com/a.js', import.meta.url);",
        'const name = "x";',
        'vi.doMock(name);',
        "vi.mock(import('@root/a/_/own'));",
        'export const all = [actual, worker, remote];',
        '',
      ].join('\n'),
    });
    const imports = (await code(project, ['root/a/_/test.ts']))['root/a/_/test.ts']!.imports;
    expect(imports).toEqual([
      { kind: 'internal', target: 'root/a/_/own.ts', names: [], line: 2 },
      { kind: 'internal', target: 'root/b/_/secret.ts', names: [], line: 3 },
      { kind: 'package', target: 'axios', declared: true, names: [], line: 4 },
      { kind: 'internal', target: 'root/b/_/secret.ts', names: [], line: 5 },
      { kind: 'relative', target: './worker.ts', names: [], line: 6 },
      { kind: 'dynamic', target: null, line: 9 },
      { kind: 'dynamic', target: '@root/a/_/own', line: 10 },
    ]);
  });

  test('new URL with a relative path to an existing file is an internal import of that file', async () => {
    const project = fixture({
      'root/a/_/worker.ts': 'export {};\n',
      'root/b/_/worker.ts': 'export {};\n',
      'root/a/_/test.ts': [
        "export const own = new URL('./worker.ts', import.meta.url);",
        "export const other = new URL('../../b/_/worker.ts?worker', import.meta.url);",
        '',
      ].join('\n'),
    });
    const imports = (await code(project, ['root/a/_/test.ts']))['root/a/_/test.ts']!.imports;
    expect(imports).toEqual([
      { kind: 'internal', target: 'root/a/_/worker.ts', names: [], line: 1 },
      { kind: 'internal', target: 'root/b/_/worker.ts', names: [], line: 2 },
    ]);
  });
});

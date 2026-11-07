import { describe, expect, it } from 'vitest';
import { scan } from './scan.js';

// Edge cases that the phase 0 spike checked against the TypeScript AST.
const TRICKY = `#!/usr/bin/env node
// import x from 'comment'
/* require('nope') */
import a, { b as c, type d } from './a';
import type { T } from "./t";
import * as ns from '@b/x';
import './side';
import { type A, type B } from './ab';
import type from './typedefault';
import fs = require('fs');
import json from './data.json' with { type: 'json' };
export { e, f as g } from './ef';
export type { H } from './h';
export * from './star';
export * as nn from './nn';
export { default } from './def';
export { default as named, 'quoted' as q2 } from './def2';
const s = \`tpl \${ \`nested \${ 'import(\\'x\\')' }\` } import('no')\`;
const r = /import\\('re'\\)/g;
const cls = /[/'"\`]/;
const q = 10 / 2 / 3; import('./ok');
async function f(name: string) {
  const { m, n: o, ...rest } = await import('./mn');
  const z = require(name);
  const obj = { import: (x: string) => x };
  obj.import('nope');
  return import(\`./tpl\`);
}
declare function require(x: string): unknown;
const { k } = require('./k');
export const v = import.meta.url;
let w = require('./w');
interface Loader { import(id: string): Promise<unknown>; require(id: string): unknown }
class Runner { async import(id: string) { return id; } }
const chained = async () => { const { then } = await import('./chained').then((m) => m); return then; };
`;

const N = (...names: string[]) => names.map((name) => ({ name, typeOnly: false }));
const T = (...names: string[]) => names.map((name) => ({ name, typeOnly: true }));

describe('scan', () => {
  it('finds every import of the tricky file with lines, names and type flags', () => {
    const { imports } = scan(TRICKY);
    const brief = imports.map((i) => [i.line, i.kind, i.reexport, i.literal ? i.specifier : null, i.names]);
    expect(brief).toEqual([
      [4, 'static', false, './a', [...N('default', 'b'), ...T('d')]],
      [5, 'static', false, './t', T('T')],
      [6, 'static', false, '@b/x', '*'],
      [7, 'static', false, './side', []],
      [8, 'static', false, './ab', T('A', 'B')],
      [9, 'static', false, './typedefault', N('default')],
      [10, 'require', false, 'fs', '*'],
      [11, 'static', false, './data.json', N('default')],
      [12, 'static', true, './ef', N('e', 'f')],
      [13, 'static', true, './h', T('H')],
      [14, 'static', true, './star', '*'],
      [15, 'static', true, './nn', '*'],
      [16, 'static', true, './def', N('default')],
      [17, 'static', true, './def2', N('default', 'quoted')],
      [21, 'dynamic', false, './ok', '*'],
      [23, 'dynamic', false, './mn', '*'],
      [24, 'require', false, null, '*'],
      [27, 'dynamic', false, './tpl', '*'],
      [30, 'require', false, './k', N('k')],
      [32, 'require', false, './w', '*'],
      [35, 'dynamic', false, './chained', '*'],
    ]);
    expect(imports.find((i) => i.line === 24)!.specifier).toBe('name');
    expect(imports.find((i) => i.line === 12)!.exported).toEqual([
      { name: 'e', as: 'e', typeOnly: false },
      { name: 'f', as: 'g', typeOnly: false },
    ]);
    expect(imports.find((i) => i.line === 15)!.starAs).toBe('nn');
  });

  it('lists the exported names and the code lines of a public file', () => {
    const text = [
      "export { charge, refund as back } from './client';",
      "export type { Invoice } from './types';",
      "export * from './all';",
      '// a comment',
      '',
      "export { default as Main } from './main';",
      'export const fee = 1;',
      'export default function run() {}',
      'export interface Shape { a: number }',
      "import { x } from './x';",
    ].join('\n');
    const { exports } = scan(text, { exports: true });
    expect(exports).toEqual({
      names: [
        { name: 'charge', line: 1, typeOnly: false },
        { name: 'back', line: 1, typeOnly: false },
        { name: 'Invoice', line: 2, typeOnly: true },
        { name: 'Main', line: 6, typeOnly: false },
        { name: 'fee', line: 7, typeOnly: false },
        { name: 'default', line: 8, typeOnly: false },
        { name: 'Shape', line: 9, typeOnly: true },
      ],
      codeLines: [7, 8, 9, 10],
    });
  });

  it('gives a file of named re-exports no code lines', () => {
    expect(scan("export { a } from './a';\nexport type { B } from './b' with { type: 'x' };\n", { exports: true }).exports!.codeLines).toEqual([]);
  });

  it('names the keys a lazy import destructures', () => {
    const text = [
      "import('./a').then(({ a, b: c }) => a + c);",
      "import('./b').then(async ({ a }) => a);",
      "import('./c').then(function ({ a }) { return a; });",
      "import('./d').then(function load({ a }: { a: number }) { return a; });",
      "import('./e').then(({ default: X }: typeof import('./e2')) => X);",
      "const { a } = await import('./f');",
      "let { b, c: d } = import('./g');",
      "var { e } = await import('./h');",
      "const { f } = await import('./i').then((m) => m);",
      "const { g } = await import('./j').then(({ h }) => h);",
      "import('./k').then((m) => m.a);",
      "import('./l').then(m => m.a);",
      "import('./m').then(({ a, ...rest }) => rest);",
      "const { a: x, ...more } = await import('./n');",
      "const { [key]: y } = await import('./o');",
      "import('./p').then(({}) => 1);",
    ].join('\n');
    const names = Object.fromEntries(scan(text).imports.map((i) => [i.specifier, i.names]));
    expect(names).toEqual({
      './a': N('a', 'b'),
      './b': N('a'),
      './c': N('a'),
      './d': N('a'),
      './e': N('default'),
      './e2': '*',
      './f': N('a'),
      './g': N('b', 'c'),
      './h': N('e'),
      './i': '*',
      './j': N('h'),
      './k': '*',
      './l': '*',
      './m': '*',
      './n': '*',
      './o': '*',
      './p': '*',
    });
  });

  it('counts lines across CRLF line endings', () => {
    expect(scan("// one\r\n\r\nimport { a } from './a';\r\n").imports[0]!.line).toBe(3);
  });
});

import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadTypeScript, readProjectConfig } from './env.js';
import { analyze } from './index.js';
import { SignatureHasher } from './signature.js';
import { Fixture } from './test-fixture.js';

const fixtures: Fixture[] = [];
afterAll(() => {
  for (const created of fixtures) created.remove();
});

const DMZ = 'root/dmz/lib/app.ts';

/** Builds a project whose `root/lib/_/` holds `files` and whose DMZ re-exports `names` from lib.ts. Returns name -> signature. */
async function signatures(files: Record<string, string>, names: string[]): Promise<Record<string, string>> {
  const project = new Fixture({
    ...prefix(files),
    [DMZ]: `export { ${names.join(', ')} } from '@root/lib/_/lib';\n`,
  });
  fixtures.push(project);
  const response = await analyze(project.dir, project.request([DMZ], []));
  const entry = response.dmz[DMZ]!;
  expect(entry.violations).toEqual([]);
  return Object.fromEntries(entry.exports.map((e) => [e.name, e.signature]));
}

/** The text that is hashed, for each exported name, built from one project. */
function descriptions(files: Record<string, string>, names: string[]): { texts: Record<string, string>; dir: string } {
  const project = new Fixture({ ...prefix(files), [DMZ]: `export { ${names.join(', ')} } from '@root/lib/_/lib';
` });
  fixtures.push(project);
  const ts = loadTypeScript(project.dir);
  const program = ts.createProgram([path.join(project.dir, DMZ)], readProjectConfig(ts, project.dir, 'root').options);
  const checker = program.getTypeChecker();
  const hasher = new SignatureHasher(ts, program, checker, project.dir);
  const source = program.getSourceFile(path.join(project.dir, DMZ))!;
  const statement = source.statements[0] as import('typescript').ExportDeclaration;
  const elements = (statement.exportClause as import('typescript').NamedExports).elements;
  const texts = Object.fromEntries(elements.map((element) => [element.name.text, hasher.describe(checker.getExportSpecifierLocalTargetSymbol(element)!)]));
  return { texts, dir: project.dir };
}

function prefix(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [`root/lib/_/${name}`, content]));
}

/** Asserts that every listed name keeps (or changes) its signature between two versions of the code. */
async function compare(before: Record<string, string>, after: Record<string, string>, names: string[]) {
  const [a, b] = await Promise.all([signatures(before, names), signatures(after, names)]);
  return Object.fromEntries(names.map((name) => [name, a[name] === b[name] ? 'same' : 'changed']));
}

const BASE = {
  'lib.ts': `
import type { Entry } from './types';
export type { Entry } from './types';

export function format(entry: Entry, width: number): string {
  return entry.message.padEnd(width);
}

export class Store<T> {
  private items: T[] = [];
  add(item: T): void { this.items.push(item); }
  all(): readonly T[] { return this.items; }
}

export const store = new Store<Entry>();
export const VERSION = 3;
`,
  'types.ts': `
export interface Entry {
  level: 'info' | 'warn';
  message: string;
  meta?: { tags: string[] };
}
`,
};
const NAMES = ['format', 'Store', 'store', 'VERSION', 'Entry'];

describe('signature stability', { timeout: 60_000 }, () => {
  test('the same code in two folders has the same signatures', async () => {
    const [a, b] = await Promise.all([signatures(BASE, NAMES), signatures(BASE, NAMES)]);
    expect(Object.keys(a)).toEqual(NAMES);
    expect(a).toEqual(b);
  });

  test('reformatting, comments and function bodies do not change signatures', async () => {
    const after = {
      ...BASE,
      'lib.ts': BASE['lib.ts']!
        .replace('return entry.message.padEnd(width);', '// different body\n  const text = entry.message;\n  return text.padStart(width);')
        .replace('add(item: T): void { this.items.push(item); }', '/** docs */\n  add(  item : T ) : void {\n    this.items.unshift(item);\n  }')
        .replace('private items: T[] = [];', 'private items: T[] = [];\n  private extra = new Map<string, number>();'),
    };
    expect(await compare(BASE, after, NAMES)).toEqual({ format: 'same', Store: 'same', store: 'same', VERSION: 'same', Entry: 'same' });
  });

  test('moving a type to another file does not change signatures', async () => {
    const after = {
      'lib.ts': BASE['lib.ts']!.replaceAll("'./types'", "'./moved'"),
      'moved.ts': BASE['types.ts']!,
    };
    expect(await compare(BASE, after, NAMES)).toEqual({ format: 'same', Store: 'same', store: 'same', VERSION: 'same', Entry: 'same' });
  });

  test('union member order does not matter', async () => {
    const before = { 'lib.ts': "export type Level = 'a' | 'b' | 'c';\n" };
    const after = { 'lib.ts': "export type Level = 'c' | 'a' | 'b';\n" };
    expect(await compare(before, after, ['Level'])).toEqual({ Level: 'same' });
  });
});

describe('signature changes', { timeout: 60_000 }, () => {
  test('changing a parameter type changes the function signature only', async () => {
    const after = { ...BASE, 'lib.ts': BASE['lib.ts']!.replace('width: number', 'width: string') };
    expect(await compare(BASE, after, NAMES)).toEqual({ format: 'changed', Store: 'same', store: 'same', VERSION: 'same', Entry: 'same' });
  });

  test('changing an interface field changes the interface and everything that uses it', async () => {
    const after = { ...BASE, 'types.ts': BASE['types.ts']!.replace('message: string;', 'message: number;') };
    expect(await compare(BASE, after, NAMES)).toEqual({ format: 'changed', Store: 'same', store: 'changed', VERSION: 'same', Entry: 'changed' });
  });

  test('a nested field, an optional marker and a new field are all changes', async () => {
    const nested = { ...BASE, 'types.ts': BASE['types.ts']!.replace('tags: string[]', 'tags: number[]') };
    const optional = { ...BASE, 'types.ts': BASE['types.ts']!.replace('message: string;', 'message?: string;') };
    const added = { ...BASE, 'types.ts': BASE['types.ts']!.replace('message: string;', 'message: string;\n  id: number;') };
    for (const after of [nested, optional, added]) {
      expect((await compare(BASE, after, ['Entry', 'format'])).Entry).toBe('changed');
    }
  });

  test('changing a return type, adding a parameter, adding an overload or a method are changes', async () => {
    const variants = {
      returnType: BASE['lib.ts']!.replace('width: number): string', 'width: number): string | undefined'),
      parameter: BASE['lib.ts']!.replace('width: number)', 'width: number, fill?: string)'),
      overload: BASE['lib.ts']!.replace('export function format(', 'export function format(entry: Entry): string;\nexport function format(entry: Entry, width: number): string;\nexport function format(').replace('width: number): string {', 'width?: number): string {').replace('padEnd(width)', 'padEnd(width ?? 0)'),
      method: BASE['lib.ts']!.replace('all():', 'clear(): void { this.items = []; }\n  all():'),
      generic: BASE['lib.ts']!.replace('new Store<Entry>()', 'new Store<string>()'),
      constant: BASE['lib.ts']!.replace('VERSION = 3', 'VERSION = 4'),
    };
    const result: Record<string, Record<string, string>> = {};
    for (const [key, lib] of Object.entries(variants)) result[key] = await compare(BASE, { ...BASE, 'lib.ts': lib }, NAMES);
    expect(result.returnType!.format).toBe('changed');
    expect(result.parameter!.format).toBe('changed');
    expect(result.overload!.format).toBe('changed');
    expect(result.method).toMatchObject({ Store: 'changed', store: 'changed', format: 'same' });
    expect(result.generic).toMatchObject({ store: 'changed', Store: 'same' });
    expect(result.constant).toMatchObject({ VERSION: 'changed', format: 'same' });
  });

  test('a private member is not part of the signature, a public one is', async () => {
    const privateChange = { ...BASE, 'lib.ts': BASE['lib.ts']!.replace('private items: T[]', 'private items: Array<T | null>') };
    const publicChange = { ...BASE, 'lib.ts': BASE['lib.ts']!.replace('private items: T[]', 'public items: T[]') };
    expect((await compare(BASE, privateChange, ['Store'])).Store).toBe('same');
    expect((await compare(BASE, publicChange, ['Store'])).Store).toBe('changed');
  });
});

describe('signature description', () => {
  const files = {
    'lib.ts': `
import type { Other } from './other';
export interface Tree { value: Other; children: Tree[]; parent?: Tree }
export type Json = string | number | Json[] | { [key: string]: Json };
export type Pick2<T> = T extends Other ? T['id'] : never;
export type Lazy = typeof import('./other');
export function guard(value: unknown): value is Other { return value !== null; }
export enum Color { Red, Green = 'g' }
export namespace Space { export const x = 1; }
export type Deep = { a: A1 };
export type SelfRef = { self?: SelfRef; n: number };
interface A1 { b: A2 }
interface A2 { c: A3 }
interface A3 { d: A4 }
interface A4 { e: string }
`,
    'other.ts': 'export interface Other { id: number }\nexport const value = 1;\n',
  };

  test('contains no absolute path, even for import() types', () => {
    const { texts, dir } = descriptions(files, ['Tree', 'Json', 'Pick2', 'Lazy', 'guard', 'Color', 'Space']);
    for (const text of Object.values(texts)) {
      expect(text).not.toContain(dir.replace(/\\/g, '/'));
      expect(text).not.toContain(dir);
      expect(text).not.toMatch(/node_modules|[A-Za-z]:\//);
    }
  });

  test('describes structure, following named project types', () => {
    const { texts } = descriptions(files, ['Tree', 'Json', 'Pick2', 'guard', 'Color', 'Lazy', 'Space', 'SelfRef']);
    expect(texts).toEqual({
      Tree: 'interface { children: Array<Tree>; parent?: Tree | undefined; value: Other { id: number } }',
      Json: 'type Array<Json> | number | string | { [key: string]: Json }',
      Pick2: 'type<T> (T extends Other { id: number } ? T["id"] : never)',
      guard: 'function (value: unknown) => value is Other { id: number }',
      Color: 'enum { Red = 0; Green = "g" }',
      Lazy: 'type { value: 1 }',
      Space: 'namespace { x: value 1 }',
      SelfRef: 'type { n: number; self?: SelfRef | undefined }',
    });
  });

  test('a property keyed by a unique symbol is written without the internal symbol id', () => {
    const symbolFiles = {
      'lib.ts': "const first: unique symbol = Symbol();\nconst key: unique symbol = Symbol();\nexport const keyed = { [first]: 'a', [key]: 1 };\n",
    };
    expect(descriptions(symbolFiles, ['keyed']).texts.keyed).toBe('value { [first]: string; [key]: number }');
  });

  test('stops expanding named types after depth 3', () => {
    expect(descriptions(files, ['Deep']).texts.Deep).toBe('type { a: A1 { b: A2 { c: A3 { d: A4 } } } }');
  });
});

describe('class contracts', { timeout: 60_000 }, () => {
  const CLASS = {
    'lib.ts': `
export class Service {
  constructor(readonly name: string) {}
  value = 1;
  run(input: string): string { return input; }
  get size(): number { return 1; }
  helper: (x: number) => number = (x) => x;
  static create(): Service { return new Service('x'); }
}
`,
  };
  const variant = (from: string, to: string) => ({ 'lib.ts': CLASS['lib.ts'].replace(from, to) });
  const changed = async (after: Record<string, string>) => (await compare(CLASS, after, ['Service'])).Service;

  test('accessibility of members and constructors is part of the contract', async () => {
    expect(await changed(variant('  run(', '  protected run('))).toBe('changed');
    expect(await changed(variant('  run(', '  private run('))).toBe('changed');
    expect(await changed(variant('  run(', '  public run('))).toBe('same');
    expect(await changed(variant('  static create', '  protected static create'))).toBe('changed');
    expect(await changed(variant('  constructor(', '  private constructor('))).toBe('changed');
    expect(await changed(variant('  constructor(', '  protected constructor('))).toBe('changed');
    expect(await changed(variant('readonly name', 'protected readonly name'))).toBe('changed');
  });

  test('abstract classes and members are part of the contract', async () => {
    expect(await changed(variant('export class Service', 'export abstract class Service'))).toBe('changed');
    const abstractBase = { 'lib.ts': 'export abstract class Base {\n  abstract run(): void;\n  done(): void {}\n}\n' };
    const concreteRun = { 'lib.ts': 'export abstract class Base {\n  run(): void {}\n  done(): void {}\n}\n' };
    expect((await compare(abstractBase, concreteRun, ['Base'])).Base).toBe('changed');
  });

  test('accessors, methods and function-typed properties are told apart', async () => {
    // A getter alone reads like a readonly property, so it differs from a plain property...
    expect(await changed(variant('get size(): number { return 1; }', 'size = 1;'))).toBe('changed');
    // ...and adding a setter makes it assignable.
    expect(await changed(variant('get size(): number { return 1; }', 'get size(): number { return 1; }\n  set size(v: number) { void v; }'))).toBe('changed');
    expect(await changed(variant('get size(): number { return 1; }', 'readonly size: number = 1;'))).toBe('same');
    expect(await changed(variant('helper: (x: number) => number = (x) => x;', 'helper(x: number): number { return x; }'))).toBe('changed');
    expect(await changed(variant('run(input: string): string { return input; }', 'run = (input: string): string => input;'))).toBe('changed');
  });

  test('a this parameter is part of a signature', async () => {
    const before = { 'lib.ts': 'export function bound(x: number): number { return x; }\n' };
    const after = { 'lib.ts': 'export function bound(this: { base: number }, x: number): number { return this.base + x; }\n' };
    expect((await compare(before, after, ['bound'])).bound).toBe('changed');
  });
});

describe('mapped types', { timeout: 60_000 }, () => {
  test('union order inside a mapped type does not depend on what the checker met first', async () => {
    // Hashing Order first creates the literal types "off" and "on" in that order. The printer
    // would then write the template of Flags as "off" | "on" instead of "on" | "off".
    const before = { 'lib.ts': "export type Order = 'x' | 'y';\nexport type Flags<T> = { readonly [K in keyof T]?: 'on' | 'off' };\n" };
    const after = { 'lib.ts': "export type Order = 'off' | 'on';\nexport type Flags<T> = { readonly [K in keyof T]?: 'on' | 'off' };\n" };
    expect(await compare(before, after, ['Order', 'Flags'])).toEqual({ Order: 'changed', Flags: 'same' });
  });

  test('modifiers, the constraint, the as clause and the template are part of a mapped type', async () => {
    const base = 'export type M<T> = { readonly [K in keyof T]?: T[K] };\n';
    const variants = {
      readonly: base.replace('readonly [K', '[K'),
      minusReadonly: base.replace('readonly [K', '-readonly [K'),
      optional: base.replace(']?:', ']:'),
      minusOptional: base.replace(']?:', ']-?:'),
      constraint: base.replace('keyof T', 'keyof T & string'),
      as: base.replace('in keyof T]', 'in keyof T as `get${K & string}`]'),
      template: base.replace(': T[K]', ': T[K] | null'),
    };
    for (const [name, lib] of Object.entries(variants)) {
      expect((await compare({ 'lib.ts': base }, { 'lib.ts': lib }, ['M'])).M, name).toBe('changed');
    }
  });

  test('a mapped type seen through an instantiation keeps the instantiated constraint', async () => {
    const base = 'export class Base<T> { view!: { [K in keyof T]: T[K] }; }\nexport class Child<T> extends Base<T[]> {}\n';
    const after = base.replace('extends Base<T[]>', 'extends Base<T>');
    expect(await compare({ 'lib.ts': base }, { 'lib.ts': after }, ['Child'])).toEqual({ Child: 'changed' });
  });

  test('a mapped type is described part by part', () => {
    const files = { 'lib.ts': "export type M<T> = { readonly [K in keyof T]?: T[K] | 'b' | 'a' };\n" };
    expect(descriptions(files, ['M']).texts.M).toBe('type<T> {  } mapped { +readonly [K in keyof T]+?: "a" | "b" | T[K] }');
  });
});

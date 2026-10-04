import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { signatureReader } from './signature-text.js';

afterEach(cleanupProjects);

const SOURCE = [
  '/** Docs are left out. */',
  'export function sum(a: number, b: number): number;',
  'export function sum(a: string, b: string): string;',
  'export function sum(a: any, b: any): any {',
  '  return a + b;',
  '}',
  'export const double = (n: number): number => n * 2;',
  'export const limit: number = compute();',
  "export const name = 'x';",
  'export interface Point {',
  '  x: number;',
  '  y: number;',
  '}',
  "export type Id = string & { readonly brand: 'id' };",
  'export enum Mode { A, B }',
  'export class Store {',
  '  private secret = 1;',
  '  readonly size: number = 0;',
  '  constructor(public label: string) {}',
  '  get(key: string): string | undefined {',
  '    return key;',
  '  }',
  '}',
  'function compute(): number { return 1; }',
  "export { inner as renamed } from './other';",
  '',
].join('\n');

describe('signatureReader', () => {
  const dir = () => makeProject({ 'root/a/_/x.ts': SOURCE });

  it.each([
    ['sum', 'export function sum(a: number, b: number): number\nexport function sum(a: string, b: string): string\nexport function sum(a: any, b: any): any'],
    ['double', 'export const double = (n: number): number =>'],
    ['limit', 'export const limit: number'],
    ['name', "export const name = 'x'"],
    ['Point', 'export interface Point {\n  x: number;\n  y: number;\n}'],
    ['Id', "export type Id = string & { readonly brand: 'id' };"],
    ['Mode', 'export enum Mode { A, B }'],
    ['Store', 'export class Store {\n  readonly size: number;\n  constructor(public label: string);\n  get(key: string): string | undefined;\n}'],
    ['renamed', "export { inner as renamed } from './other'"],
  ])('reads the declaration of %s without bodies', (name, expected) => {
    expect(signatureReader(dir()).read('root/a/_/x.ts', name)).toBe(expected);
  });

  it('returns null for a name or file it cannot find', () => {
    const reader = signatureReader(dir());
    expect(reader.read('root/a/_/x.ts', 'missing')).toBeNull();
    expect(reader.read('root/a/_/nope.ts', 'sum')).toBeNull();
  });

  it('cuts long declarations', () => {
    const fields = Array.from({ length: 60 }, (_, i) => `  f${i}: number;`).join('\n');
    const project = makeProject({ 'root/a/_/big.ts': `export interface Big {\n${fields}\n}\n` });
    const text = signatureReader(project).read('root/a/_/big.ts', 'Big')!;
    expect(text.split('\n')).toHaveLength(41);
    expect(text.endsWith('\n...')).toBe(true);
  });
});

// Differential test: scan() against the TypeScript AST on the sources of this repo and a fixed sample of node_modules.
// The AST walker below states the expected answer from the protocol (ImportRecord and PublicExports in
// adapters/ts/src/protocol.ts), so a difference is a scanner bug unless ALLOWED lists it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { scan, type ScannedImport, type ScannedName } from './scan.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_DIRS = ['cli/src', 'adapters', 'docs', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cache', '.test-tmp', '.git']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// The first files, in sorted path order, of each folder: about 370 files, with the repo sources about 560.
const SAMPLE: [string, number][] = [
  ['node_modules/@types/node', 80],
  ['node_modules/vite/dist', 40],
  ['node_modules/vitest/dist', 60],
  ['node_modules/rollup/dist', 20],
  ['node_modules/vue/dist', 20],
  ['node_modules/@vue/shared/dist', 10],
  ['node_modules/sucrase/dist', 60],
  ['node_modules/postcss/lib', 60],
  ['node_modules/commander', 10],
  ['node_modules/magic-string/dist', 10],
  ['node_modules/esbuild/lib', 10],
  ['node_modules/typescript/lib', 30],
  ['node_modules/shiki/dist', 40],
];
const SAMPLE_EXT = /\.(ts|js|mjs|cjs)$/;
const MAX_SIZE = 400_000;

// Forms that the corpus lacks, checked the same way. Each one once broke the scanner or is one of its known limits.
const SNIPPETS: Record<string, string> = {
  'template-import': 'const m = await import(`./locale/${lang}.js`);\nimport(`./b/${x}`).then(({ a }) => a);\nimport("./after");',
  'call-arguments': "import(name, { with: { type: 'json' } });\nrequire(a, b);\nimport('./q')?.then(({ a }) => a);",
  'export-import': "export import fs = require('fs');\nexport import A = B.C;",
  'ambient-module': "declare module 'm' {\n  import { a } from './a';\n  export { b } from './b';\n  export const c: 1;\n}\nexport const d = 1;",
  'decorator': '@dec\nexport class A {}',
  'regex-after-paren': "if (x) /import('a')/.test(y);",
  'export-list': 'export const a = 1, b = 2;',
  'export-pattern': 'export const { c, d: [e] } = o;',
};

// Known limits of the scanner that the test accepts: a path suffix and a line of the file, with the reason.
const ALLOWED: { file: string; line: number; reason: string }[] = [
  { file: 'snippet/regex-after-paren.ts', line: 1, reason: 'a regex literal right after `)` reads as a division (see the scan.ts header)' },
  { file: 'snippet/export-list.ts', line: 1, reason: 'only the first name of `export const a = 1, b = 2` is listed: the end of an initializer needs ASI' },
  { file: 'snippet/export-pattern.ts', line: 1, reason: '`export const { a } = o` lists no names' },
];

function walk(dir: string, ext: RegExp, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, ext, out);
    } else if (ext.test(name) && st.size <= MAX_SIZE) out.push(full);
  }
}

function corpus(): string[] {
  const files: string[] = [];
  for (const dir of SOURCE_DIRS) walk(path.join(ROOT, dir), SOURCE_EXT, files);
  for (const [dir, count] of SAMPLE) {
    const found: string[] = [];
    walk(path.join(ROOT, dir), SAMPLE_EXT, found);
    files.push(...found.slice(0, count));
  }
  return files;
}

type Names = ScannedName[] | '*';
interface Expected {
  imports: ScannedImport[];
  names: { name: string; line: number; typeOnly: boolean }[];
  firstCodeLine: number | undefined;
}

const keyText = (key: ts.PropertyName | ts.ModuleExportName): string | undefined =>
  ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : undefined;

// The keys of an object binding pattern. '*' when nothing is destructured or a key has no static name.
function patternNames(name: ts.BindingName): Names {
  if (!ts.isObjectBindingPattern(name) || name.elements.length === 0) return '*';
  const names: ScannedName[] = [];
  for (const el of name.elements) {
    const key = el.dotDotDotToken ? undefined : keyText(el.propertyName ?? (el.name as ts.Identifier));
    if (key === undefined) return '*';
    names.push({ name: key, typeOnly: false });
  }
  return names;
}

// The names an import() or require() call uses: what `const { a } = [await] call` destructures and, for import(),
// what the first parameter of `.then(cb)` destructures.
function callNames(call: ts.CallExpression, dynamic: boolean): Names {
  const up = call.parent;
  if (dynamic && ts.isPropertyAccessExpression(up) && up.expression === call && up.name.text === 'then' && ts.isCallExpression(up.parent) && up.parent.expression === up) {
    const cb = up.parent.arguments[0];
    return cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] ? patternNames(cb.parameters[0].name) : '*';
  }
  const value = ts.isAwaitExpression(up) ? up : call;
  const decl = value.parent;
  return ts.isVariableDeclaration(decl) && decl.initializer === value ? patternNames(decl.name) : '*';
}

function boundNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out);
}

function expected(file: string, text: string): Expected {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const found: [number, ScannedImport][] = [];
  const add = (pos: number, imp: Omit<ScannedImport, 'line'>): void => {
    found.push([pos, { ...imp, line: lineOf(pos) }]);
  };
  const argument = (arg: ts.Expression | undefined): { specifier: string; literal: boolean } =>
    arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? { specifier: arg.text, literal: true } : { specifier: arg ? arg.getText(sf) : '', literal: false };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      let names: Names = [];
      if (clause) {
        const typeOnly = clause.isTypeOnly;
        if (clause.name) names.push({ name: 'default', typeOnly });
        const b = clause.namedBindings;
        if (b && ts.isNamespaceImport(b)) names = '*';
        else if (b) for (const el of b.elements) names.push({ name: keyText(el.propertyName ?? el.name)!, typeOnly: typeOnly || el.isTypeOnly });
      }
      add(node.getStart(sf), { kind: 'static', reexport: false, specifier: (node.moduleSpecifier as ts.StringLiteral).text, literal: true, names });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(text.indexOf('import', node.getStart(sf)), { kind: 'require', reexport: false, ...argument(node.moduleReference.expression), names: '*' });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const base = { kind: 'static', reexport: true, specifier: (node.moduleSpecifier as ts.StringLiteral).text, literal: true } as const;
      const c = node.exportClause;
      if (!c || ts.isNamespaceExport(c)) {
        add(node.getStart(sf), { ...base, names: '*', starAs: c ? keyText(c.name)! : null });
      } else {
        const types = c.elements.map((el) => node.isTypeOnly || el.isTypeOnly);
        add(node.getStart(sf), {
          ...base,
          names: c.elements.map((el, k) => ({ name: keyText(el.propertyName ?? el.name)!, typeOnly: types[k]! })),
          exported: c.elements.map((el, k) => ({ name: keyText(el.propertyName ?? el.name)!, as: keyText(el.name)!, typeOnly: types[k]! })),
        });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.getStart(sf), { kind: 'dynamic', reexport: false, ...argument(node.arguments[0]), names: callNames(node, true) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      add(node.getStart(sf), { kind: 'require', reexport: false, ...argument(node.arguments[0]), names: callNames(node, false) });
    } else if (ts.isImportTypeNode(node)) {
      // `typeof import('x')` and `import('x').T` in a type
      const arg = node.argument;
      const literal = ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal);
      add(text.indexOf('import', node.getStart(sf)), { kind: 'dynamic', reexport: false, specifier: literal ? (arg.literal as ts.StringLiteral).text : arg.getText(sf), literal, names: '*' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  found.sort((a, b) => a[0] - b[0]);

  const names: Expected['names'] = [];
  let firstCodeLine: number | undefined;
  for (const st of sf.statements) {
    const line = lineOf(st.getStart(sf));
    const isReexport = ts.isExportDeclaration(st) && st.moduleSpecifier !== undefined;
    if (firstCodeLine === undefined && !isReexport && !ts.isEmptyStatement(st)) firstCodeLine = line;
    if (ts.isExportDeclaration(st)) {
      const c = st.exportClause;
      if (c && ts.isNamespaceExport(c)) names.push({ name: keyText(c.name)!, line, typeOnly: st.isTypeOnly });
      else if (c) for (const el of c.elements) names.push({ name: keyText(el.name)!, line, typeOnly: st.isTypeOnly || el.isTypeOnly });
      continue;
    }
    if (ts.isExportAssignment(st)) {
      if (!st.isExportEquals) names.push({ name: 'default', line, typeOnly: false });
      continue;
    }
    const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
    const exportKeyword = mods.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exportKeyword) continue;
    // the line of `export`, which comes after any decorator
    const at = lineOf(exportKeyword.getStart(sf));
    if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.push({ name: 'default', line: at, typeOnly: false });
    } else if (ts.isVariableStatement(st)) {
      const bound: string[] = [];
      for (const d of st.declarationList.declarations) boundNames(d.name, bound);
      for (const name of bound) names.push({ name, line: at, typeOnly: false });
    } else if (ts.isImportEqualsDeclaration(st)) {
      names.push({ name: st.name.text, line: at, typeOnly: st.isTypeOnly });
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) && st.name && ts.isIdentifier(st.name)) {
      names.push({ name: st.name.text, line: at, typeOnly: ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) });
    }
  }
  return { imports: found.map(([, imp]) => imp), names, firstCodeLine };
}

// One line per difference: the JSON of an import that only one side has, or a differing export or code line.
function differences(rel: string, text: string): { line: number; what: string }[] {
  const want = expected(rel, text);
  const got = scan(text, { exports: true });
  const out: { line: number; what: string }[] = [];
  const key = (i: ScannedImport): string => JSON.stringify(i, ['line', 'kind', 'reexport', 'specifier', 'literal', 'names', 'name', 'typeOnly', 'exported', 'as', 'starAs']);
  const wantKeys = want.imports.map(key);
  const gotKeys = got.imports.map(key);
  const left = [...gotKeys];
  wantKeys.forEach((k, n) => {
    const at = left.indexOf(k);
    if (at >= 0) left.splice(at, 1);
    else out.push({ line: want.imports[n]!.line, what: `missing import ${k}` });
  });
  for (const k of left) out.push({ line: (JSON.parse(k) as ScannedImport).line, what: `extra import ${k}` });
  if (out.length === 0 && wantKeys.join() !== gotKeys.join()) out.push({ line: 0, what: 'imports in another order' });
  const wantNames = JSON.stringify(want.names);
  const gotNames = JSON.stringify(got.exports!.names);
  if (wantNames !== gotNames) {
    const k = want.names.findIndex((n, j) => JSON.stringify(n) !== JSON.stringify(got.exports!.names[j]));
    const line = want.names[k]?.line ?? got.exports!.names[k]?.line ?? 0;
    out.push({ line, what: `export names differ from ${JSON.stringify(want.names[k])}, scan has ${JSON.stringify(got.exports!.names[k])}` });
  }
  const firstCode = got.exports!.codeLines[0];
  if (firstCode !== want.firstCodeLine) out.push({ line: want.firstCodeLine ?? firstCode ?? 0, what: `first code line ${String(want.firstCodeLine)}, scan has ${String(firstCode)}` });
  return out;
}

describe('scan against the TypeScript AST', () => {
  it('agrees on imports, export names and the first code line', () => {
    const files = corpus();
    expect(files.length).toBeGreaterThan(500);
    const texts: [string, string][] = files.map((file) => [path.relative(ROOT, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')]);
    for (const [name, text] of Object.entries(SNIPPETS)) texts.push([`snippet/${name}.ts`, text]);
    const mismatches: string[] = [];
    const allowedSeen = new Set<number>();
    for (const [rel, text] of texts) {
      for (const d of differences(rel, text)) {
        const allowed = ALLOWED.findIndex((a) => rel.endsWith(a.file) && a.line === d.line);
        if (allowed >= 0) allowedSeen.add(allowed);
        else mismatches.push(`${rel}:${d.line} ${d.what}`);
      }
    }
    expect(mismatches).toEqual([]);
    // an exception that no longer happens should leave the list
    expect(ALLOWED.filter((_, k) => !allowedSeen.has(k))).toEqual([]);
  });
});

// Code files: their imports, and the ways they share code without one.

import { builtinModules } from 'node:module';
import type * as TS from 'typescript';
import { packageName, type Context } from './context.js';
import type { TypeScript } from './env.js';
import type { AnalyzeResponse, ImportEntry } from './protocol.js';

const BUILTINS = new Set(builtinModules);
const NODE_MODULE = new Set(['module', 'node:module']);

type CodeEntry = AnalyzeResponse['code'][string];
type Global = NonNullable<CodeEntry['globals']>[number];

export function analyzeCode(context: Context, sourceFile: TS.SourceFile): CodeEntry {
  const imports = collectImports(context, sourceFile);
  const globals = collectGlobals(context, sourceFile);
  return globals.length > 0 ? { imports, globals } : { imports };
}

// ---------------------------------------------------------------------------
// Imports

/** One binding that an import creates in the file, such as `b` in `import { a as b }`. */
interface Binding {
  /** The name in `names`: the imported name, `default` or `*`. */
  imported: string;
  local: TS.Identifier;
}

function collectImports(context: Context, sourceFile: TS.SourceFile): ImportEntry[] {
  const { ts } = context;
  const imports: ImportEntry[] = [];
  const isJs = isJavaScript(ts, sourceFile);
  // `@import` tags exist since TypeScript 5.5; the project may load an older version.
  const isJsDocImportTag = (ts as Partial<TypeScript>).isJSDocImportTag;
  const requireCalls = findCreateRequire(ts, sourceFile);
  const pending: { entry: ImportEntry; bindings: Binding[] }[] = [];

  const line = (node: TS.Node) => context.line(sourceFile, node);
  const dynamic = (node: TS.Node, argument: TS.Expression | undefined) => {
    const target = argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null;
    imports.push({ kind: 'dynamic', target, line: line(node) });
  };
  const addStatic = (node: TS.Node, specifier: TS.Expression, names: string[], extra: Partial<ImportEntry> = {}, bindings?: Binding[]) => {
    if (!ts.isStringLiteralLike(specifier)) return;
    const entry: ImportEntry = { ...classify(context, sourceFile, specifier), names, line: line(node), ...extra };
    imports.push(entry);
    if (bindings !== undefined) pending.push({ entry, bindings });
    // `createRequire` loads modules the check cannot see, just like `require`.
    if (NODE_MODULE.has(specifier.text) && names.includes('createRequire')) dynamic(node, undefined);
  };
  /** `typeOnly` is true only when the whole statement is type-only: `import type`, or a JSDoc `@import` tag. */
  const addImportClause = (node: TS.Node, specifier: TS.Expression, clause: TS.ImportClause | undefined, alwaysTypeOnly = false) => {
    const typeOnly = alwaysTypeOnly || clause?.isTypeOnly === true;
    addStatic(node, specifier, importedNames(ts, clause), typeOnly ? { typeOnly: true } : {}, clauseBindings(ts, clause));
  };
  /**
   * `declare module '<spec>'` changes the types of another module without importing it: an augmentation inside a
   * module, an ambient module that takes over the specifier inside a script. It is an import when the specifier
   * points at project code (the alias, a relative path, or a bare specifier that resolves there). Augmenting a
   * package (`declare module 'express'`) or declaring a pattern (`declare module '*.svg'`) is not.
   */
  const addModuleDeclaration = (node: TS.ModuleDeclaration, specifier: TS.StringLiteral) => {
    const entry = classify(context, sourceFile, specifier);
    if (!context.isAlias(specifier.text) && !context.isLinkAlias(specifier.text) && entry.kind !== 'relative' && entry.kind !== 'internal') return;
    imports.push(entry.kind === 'internal' ? { ...entry, names: [], line: line(node) } : { ...entry, line: line(node) });
  };
  /** A string that loads a module outside an import statement: `vi.mock('x')`, `new URL('x', import.meta.url)`. */
  const addLoaded = (node: TS.Node, argument: TS.Expression | undefined) => {
    if (argument === undefined) return;
    if (ts.isStringLiteralLike(argument)) {
      // A URL or a server path is not a module specifier.
      if (/^[a-z][a-z\d+.-]*:/i.test(argument.text) || argument.text.startsWith('/')) return;
      addStatic(node, argument, []);
    } else if (!(ts.isCallExpression(argument) && argument.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      // `vi.mock(import('x'))` is reported through its `import()`.
      dynamic(node, undefined);
    }
  };
  const moduleClass = findModuleClass(ts, sourceFile);

  const visit = (node: TS.Node): void => {
    if (isJs) visitJsDoc(node);
    if (ts.isImportDeclaration(node)) {
      addImportClause(node, node.moduleSpecifier, node.importClause);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      const names = clause === undefined || ts.isNamespaceExport(clause) ? ['*'] : clause.elements.map((e) => (e.propertyName ?? e.name).text);
      addStatic(node, node.moduleSpecifier, names, {
        reexport: true,
        reexportedAs: exportFromNames(ts, clause),
        ...(node.isTypeOnly ? { typeOnly: true } : {}),
      });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addStatic(node, node.moduleReference.expression, ['*'], node.isTypeOnly ? { typeOnly: true } : {}, [{ imported: '*', local: node.name }]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addStatic(node, node.argument.literal as TS.Expression, importTypeNames(ts, node), { typeOnly: true });
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.parent === sourceFile) {
      addModuleDeclaration(node, node.name);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        dynamic(node, node.arguments[0]);
      } else if (requireCalls.isRequireFunction(callee) || isModuleRequire(ts, callee)) {
        dynamic(node, node.arguments[0]);
      } else if (isTestModuleHelper(ts, callee)) {
        addLoaded(node, node.arguments[0]);
      }
    } else if (ts.isNewExpression(node) && isUrlFromImportMeta(ts, node)) {
      const argument = node.arguments![0];
      // `new URL()` cannot take the alias, so a relative path is classified by the file it names.
      const file = argument !== undefined && ts.isStringLiteralLike(argument) && isRelative(argument.text) ? context.mapRelativeFile(sourceFile, argument.text) : undefined;
      if (file !== undefined) imports.push({ kind: 'internal', target: file, names: [], line: line(node) });
      else addLoaded(node, argument);
    } else if (ts.isIdentifier(node) && node.text === 'require' && isLooseRequire(ts, node)) {
      // `const r = require`, `require.resolve(...)`: the value escapes, so any call through it is unseen.
      dynamic(node, undefined);
    } else if (ts.isPropertyAccessExpression(node)) {
      if (isImportMetaGlob(ts, node)) {
        // Vite's `import.meta.glob('./*.ts')` loads every file that matches a pattern.
        if (isCallee(ts, node)) dynamic(node.parent, (node.parent as TS.CallExpression).arguments[0]);
        else dynamic(node, undefined);
      } else if (node.name.text === 'createRequire' || (isModuleRequire(ts, node) && !isCallee(ts, node))) {
        dynamic(node, undefined);
      } else if (isModuleConstructor(ts, node) || (LOADER_PROPERTIES.has(node.name.text) && moduleClass.isModuleClass(node.expression))) {
        // `module.constructor._load('x')`, `Module._load('x')`: Node's internal loader, reached without `require`.
        dynamic(node, undefined);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteralLike(key) && (key.text === 'createRequire' || key.text === 'require')) dynamic(node, undefined);
      else if (ts.isStringLiteralLike(key) && LOADER_PROPERTIES.has(key.text) && moduleClass.isModuleClass(node.expression)) dynamic(node, undefined);
    } else if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && key.text === 'createRequire') dynamic(node, undefined);
    }
    ts.forEachChild(node, visit);
  };

  /** In JavaScript files, JSDoc types are real types: `@import` tags and `import('...')` types are imports. */
  const visitJsDoc = (node: TS.Node): void => {
    const docs = (node as { jsDoc?: TS.JSDoc[] }).jsDoc;
    if (docs === undefined) return;
    const visitDoc = (child: TS.Node): void => {
      if (isJsDocImportTag?.(child)) {
        addImportClause(child, child.moduleSpecifier, child.importClause, true);
      } else if (ts.isImportTypeNode(child) && ts.isLiteralTypeNode(child.argument)) {
        addStatic(child, child.argument.literal as TS.Expression, importTypeNames(ts, child), { typeOnly: true });
      }
      ts.forEachChild(child, visitDoc);
    };
    for (const doc of docs) visitDoc(doc);
  };

  ts.forEachChild(sourceFile, visit);
  if (isJs) visitJsDoc(sourceFile.endOfFileToken);

  const withBindings = pending.filter((p) => p.bindings.length > 0);
  if (withBindings.length > 0) {
    const { used, reexported } = findUsedBindings(context, sourceFile, withBindings.flatMap((p) => p.bindings), isJs);
    for (const { entry, bindings } of withBindings) {
      const unused = unusedNames(bindings, used);
      if (unused.length > 0) entry.unusedNames = unused;
      const passed = bindings.flatMap((binding) => (reexported.get(binding) ?? []).map((as) => ({ name: binding.imported, as })));
      if (passed.length > 0) entry.reexportedAs = passed;
    }
  }
  return imports;
}

function classify(context: Context, sourceFile: TS.SourceFile, specifier: TS.StringLiteralLike): Pick<ImportEntry, 'kind' | 'target' | 'declared'> {
  const text = specifier.text;
  // The alias of a requested link resolves through the `paths` entry that analyze adds, to the path through the link.
  if (context.isAlias(text) || context.isLinkAlias(text)) {
    // TypeScript does not resolve assets (`.svg`, `.css`), so an alias that it misses is mapped by hand.
    const resolved = context.resolve(sourceFile, specifier) ?? context.mapAlias(text);
    return resolved === undefined ? { kind: 'unresolved', target: text } : { kind: 'internal', target: resolved };
  }
  if (isRelative(text)) {
    return { kind: 'relative', target: text };
  }
  // A `file:` dependency, a symlinked package or a `paths` entry can lead a bare specifier into project code.
  // This runs before the builtin test, because a `paths` entry can be named like a builtin, such as "crypto".
  const local = context.resolveLocal(sourceFile, specifier);
  if (local !== undefined) return { kind: 'internal', target: local };
  if (text.startsWith('node:') || BUILTINS.has(text)) {
    return { kind: 'builtin', target: text };
  }
  const name = packageName(text);
  if (name !== undefined) {
    return { kind: 'package', target: name, declared: context.isDeclared(name) };
  }
  return { kind: 'unresolved', target: text };
}

function isRelative(text: string): boolean {
  return text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../');
}

function importedNames(ts: TypeScript, clause: TS.ImportClause | undefined): string[] {
  return clauseBindings(ts, clause).map((binding) => binding.imported);
}

function clauseBindings(ts: TypeScript, clause: TS.ImportClause | undefined): Binding[] {
  if (clause === undefined) return [];
  const bindings: Binding[] = [];
  if (clause.name !== undefined) bindings.push({ imported: 'default', local: clause.name });
  const named = clause.namedBindings;
  if (named !== undefined) {
    if (ts.isNamespaceImport(named)) bindings.push({ imported: '*', local: named.name });
    else for (const element of named.elements) bindings.push({ imported: (element.propertyName ?? element.name).text, local: element.name });
  }
  return bindings;
}

/** `import('x').A.B` uses `A`; `typeof import('x')` uses the whole module. */
function importTypeNames(ts: TypeScript, node: TS.ImportTypeNode): string[] {
  let qualifier: TS.EntityName | undefined = node.qualifier;
  if (qualifier === undefined) return ['*'];
  while (ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
  return [qualifier.text];
}

/** `reexportedAs` of an `export ... from`: each name with its exported name, or the whole module. */
function exportFromNames(ts: TypeScript, clause: TS.NamedExportBindings | undefined): { name: string; as: string }[] {
  if (clause === undefined) return [{ name: '*', as: '*' }];
  if (ts.isNamespaceExport(clause)) return [{ name: '*', as: clause.name.text }];
  return clause.elements.map((e) => ({ name: (e.propertyName ?? e.name).text, as: e.name.text }));
}

function isJavaScript(ts: TypeScript, sourceFile: TS.SourceFile): boolean {
  const kind = (sourceFile as { scriptKind?: TS.ScriptKind }).scriptKind;
  if (kind !== undefined) return kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
  return /\.[cm]?jsx?$/i.test(sourceFile.fileName);
}

// ---------------------------------------------------------------------------
// Code loading outside import statements

/** Test helpers that load or replace a module by its specifier, so they depend on it like an import does. */
const TEST_MODULE_HELPERS: Record<string, ReadonlySet<string>> = {
  vi: new Set(['mock', 'doMock', 'importActual', 'importMock']),
  jest: new Set(['mock', 'doMock', 'requireActual', 'requireMock', 'createMockFromModule']),
};

function isTestModuleHelper(ts: TypeScript, callee: TS.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  return Object.hasOwn(TEST_MODULE_HELPERS, callee.expression.text) && TEST_MODULE_HELPERS[callee.expression.text]!.has(callee.name.text);
}

function isImportMeta(ts: TypeScript, node: TS.Expression): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';
}

/** `new URL('./worker.ts', import.meta.url)`: bundlers load the file the first argument names. */
function isUrlFromImportMeta(ts: TypeScript, node: TS.NewExpression): boolean {
  const args = node.arguments;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL' || args === undefined || args.length < 2) return false;
  const base = args[1]!;
  return ts.isPropertyAccessExpression(base) && base.name.text === 'url' && isImportMeta(ts, base.expression);
}

/** `import.meta.glob` and its variants (`globEager`). */
function isImportMetaGlob(ts: TypeScript, node: TS.PropertyAccessExpression): boolean {
  return node.name.text.startsWith('glob') && isImportMeta(ts, node.expression);
}

/** Properties of Node's Module class that load or compile code. */
const LOADER_PROPERTIES = new Set(['_load', '_compile', '_resolveFilename']);

/** `module.constructor`: Node's Module class, whose `_load` loads any file. */
function isModuleConstructor(ts: TypeScript, node: TS.PropertyAccessExpression): boolean {
  const object = skipOuterExpressions(ts, node.expression);
  return node.name.text === 'constructor' && ts.isIdentifier(object) && object.text === 'module';
}

/** Removes parentheses, `as`, `satisfies`, `<T>` and `!` around an expression, as in `(module as any).constructor`. */
function skipOuterExpressions(ts: TypeScript, node: TS.Expression): TS.Expression {
  const isSatisfies = (ts as Partial<TypeScript>).isSatisfiesExpression;
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
    else if (isSatisfies?.(node)) node = node.expression;
    else return node;
  }
}

/** The local names of Node's Module class: `Module`, and the default, namespace or `Module` imports of `module`. */
function findModuleClass(ts: TypeScript, sourceFile: TS.SourceFile): { isModuleClass(node: TS.Expression): boolean } {
  const names = new Set(['Module']);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !NODE_MODULE.has(statement.moduleSpecifier.text)) continue;
    for (const binding of clauseBindings(ts, statement.importClause)) {
      if (binding.imported === 'default' || binding.imported === '*' || binding.imported === 'Module') names.add(binding.local.text);
    }
  }
  return {
    isModuleClass: (node) => {
      const object = skipOuterExpressions(ts, node);
      return ts.isIdentifier(object) && names.has(object.text);
    },
  };
}

// ---------------------------------------------------------------------------
// require through other names

/** `module.require`, and `process.mainModule.require`. */
function isModuleRequire(ts: TypeScript, node: TS.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'require') return false;
  const object = node.expression;
  return (ts.isIdentifier(object) && object.text === 'module') || (ts.isPropertyAccessExpression(object) && object.name.text === 'mainModule');
}

function isCallee(ts: TypeScript, node: TS.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

/** An identifier `require` that is neither a direct call nor a name that only looks like it (a property, a declaration). */
function isLooseRequire(ts: TypeScript, node: TS.Identifier): boolean {
  const parent = node.parent;
  if (isCallee(ts, node)) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ((parent as { name?: TS.Node }).name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) return false;
  if (ts.isExternalModuleReference(parent)) return false;
  return true;
}

/**
 * Finds the local names bound to `createRequire` (imported from `module`, or destructured) and the
 * names that hold its result, so that `const r = createRequire(url); r('x')` reports `r('x')`.
 */
function findCreateRequire(ts: TypeScript, sourceFile: TS.SourceFile): { isRequireFunction(callee: TS.Expression): boolean } {
  const factories = new Set<string>();
  const functions = new Set<string>();
  const isFactory = (callee: TS.Expression): boolean =>
    (ts.isIdentifier(callee) && factories.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire') ||
    (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === 'createRequire');
  const isFactoryCall = (node: TS.Expression | undefined): boolean => node !== undefined && ts.isCallExpression(node) && isFactory(node.expression);

  const collectFactories = (node: TS.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'createRequire') factories.add(node.name.text);
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && key.text === 'createRequire') factories.add(node.name.text);
    }
    ts.forEachChild(node, collectFactories);
  };
  const collectFunctions = (node: TS.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFactoryCall(node.initializer)) functions.add(node.name.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isFactoryCall(node.right)) {
      functions.add(node.left.text);
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFactories(sourceFile);
  collectFunctions(sourceFile);
  return {
    isRequireFunction: (callee) => (ts.isIdentifier(callee) && functions.has(callee.text)) || isFactoryCall(skipParentheses(ts, callee)),
  };
}

function skipParentheses(ts: TypeScript, node: TS.Expression): TS.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

// ---------------------------------------------------------------------------
// Unused imports

/**
 * Returns the import bindings that the file references. Type positions count. A local re-export
 * (`export { a }`, `export default a`) does not count, because re-exporting is not using; it is
 * returned in `reexported` with the exported names, so the CLI can follow it to the files that use it.
 */
function findUsedBindings(
  context: Context,
  sourceFile: TS.SourceFile,
  bindings: Binding[],
  isJs: boolean,
): { used: Set<Binding>; reexported: Map<Binding, string[]> } {
  const { ts } = context;
  const checker = context.checker;
  const used = new Set<Binding>();
  const reexported = new Map<Binding, string[]>();
  const byName = new Map<string, { binding: Binding; symbol: TS.Symbol | undefined }[]>();
  const declarations = new Set<TS.Node>();
  for (const binding of bindings) {
    declarations.add(binding.local);
    const list = byName.get(binding.local.text) ?? [];
    list.push({ binding, symbol: checker.getSymbolAtLocation(binding.local) });
    byName.set(binding.local.text, list);
  }

  let hasJsx = false;
  const check = (node: TS.Identifier): void => {
    const candidates = byName.get(node.text);
    if (candidates === undefined || declarations.has(node) || isLocalReexport(ts, node)) return;
    const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    if (symbol === undefined) return;
    for (const candidate of candidates) if (candidate.symbol === symbol) used.add(candidate.binding);
  };
  const addReexport = (local: TS.Identifier, symbol: TS.Symbol | undefined, as: string): void => {
    if (symbol === undefined) return;
    for (const candidate of byName.get(local.text) ?? []) {
      if (candidate.symbol !== symbol) continue;
      const names = reexported.get(candidate.binding) ?? [];
      if (!names.includes(as)) names.push(as);
      reexported.set(candidate.binding, names);
    }
  };
  const visit = (node: TS.Node): void => {
    if (ts.isExportSpecifier(node) && node.parent.parent.moduleSpecifier === undefined) {
      const local = node.propertyName ?? node.name;
      if (ts.isIdentifier(local)) addReexport(local, checker.getExportSpecifierLocalTargetSymbol(node), node.name.text);
    } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      // `export default a`, and `export = a`, which a default import or `import x = require()` reads.
      addReexport(node.expression, checker.getSymbolAtLocation(node.expression), 'default');
    }
    if (ts.isIdentifier(node)) check(node);
    else if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;
    if (isJs) for (const doc of (node as { jsDoc?: TS.JSDoc[] }).jsDoc ?? []) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // The classic JSX transform calls the factory (React.createElement, h) without naming it in the code.
  if (hasJsx) {
    for (const name of jsxFactoryNames(context, sourceFile)) for (const candidate of byName.get(name) ?? []) used.add(candidate.binding);
  }
  return { used, reexported };
}

function isLocalReexport(ts: TypeScript, node: TS.Identifier): boolean {
  const parent = node.parent;
  if (ts.isExportSpecifier(parent)) return true;
  return ts.isExportAssignment(parent) && parent.expression === node;
}

function jsxFactoryNames(context: Context, sourceFile: TS.SourceFile): string[] {
  const { ts } = context;
  const options = context.program.getCompilerOptions();
  const jsx = options.jsx;
  if (jsx === ts.JsxEmit.ReactJSX || jsx === ts.JsxEmit.ReactJSXDev) return [];
  const names = ['React'];
  for (const factory of [options.jsxFactory, options.jsxFragmentFactory, options.reactNamespace]) {
    if (factory !== undefined) names.push(factory.split('.')[0]!);
  }
  for (const match of sourceFile.text.matchAll(/@jsx(?:Frag)?\s+([A-Za-z_$][\w$]*)/g)) names.push(match[1]!);
  return names;
}

function unusedNames(bindings: Binding[], used: Set<Binding>): string[] {
  const usedNames = new Set(bindings.filter((b) => used.has(b)).map((b) => b.imported));
  const unused: string[] = [];
  for (const binding of bindings) {
    if (!usedNames.has(binding.imported) && !unused.includes(binding.imported)) unused.push(binding.imported);
  }
  return unused;
}

// ---------------------------------------------------------------------------
// Globals

/** The fix for ambient declarations that exist for the build, not for other buckets. */
const MOVE_AMBIENT =
  'Move ambient declaration files out of the root folder, for example to a `types/` folder that tsconfig.json includes, so that no bucket owns them.';

/**
 * Ways a file shares code without an import: top-level declarations of a file that is not a module
 * (TypeScript makes them global), `declare global` blocks, `export as namespace` and triple-slash references.
 * Each message ends with the fix for that case.
 */
function collectGlobals(context: Context, sourceFile: TS.SourceFile): Global[] {
  const { ts } = context;
  const globals: Global[] = [];
  const ambient = isAmbientFile(ts, sourceFile);

  const script = scriptGlobals(context, sourceFile, ambient);
  if (script !== undefined) globals.push(script);

  const visit = (node: TS.Node): void => {
    if (ts.isModuleDeclaration(node) && node.flags & ts.NodeFlags.GlobalAugmentation) {
      globals.push({
        line: context.line(sourceFile, node),
        message: ambient
          ? `\`declare global\` adds names that every file can use without an import. ${MOVE_AMBIENT}`
          : '`declare global` adds names that every file can use without an import. Move the declarations out of `declare global` and export them from a module. If the build defines these names (such as a Vite `define` constant), move the declaration to a file outside the root folder instead, for example in a `types/` folder that tsconfig.json includes.',
      });
    } else if (ts.isNamespaceExportDeclaration(node)) {
      globals.push({
        line: context.line(sourceFile, node),
        message: `\`export as namespace ${node.name.text}\` makes this module a global name that any file can use without an import. Remove it and import the module where it is needed.`,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  for (const reference of sourceFile.referencedFiles) {
    globals.push({
      line: context.lineAt(sourceFile, reference.pos),
      message: ambient
        ? `\`/// <reference path="${reference.fileName}" />\` pulls another file in without an import. ${MOVE_AMBIENT}`
        : `\`/// <reference path="${reference.fileName}" />\` pulls another file in without an import. Remove it and import what the file needs.`,
    });
  }
  for (const reference of sourceFile.typeReferenceDirectives) {
    globals.push({
      line: context.lineAt(sourceFile, reference.pos),
      message: ambient
        ? `\`/// <reference types="${reference.fileName}" />\` adds global declarations without an import. ${MOVE_AMBIENT} Or remove the line and list the types in compilerOptions.types.`
        : `\`/// <reference types="${reference.fileName}" />\` adds global declarations without an import. Remove it and import what the file needs, or list the types in compilerOptions.types.`,
    });
  }
  return globals.sort((a, b) => a.line - b.line);
}

/**
 * True for a file that only describes the environment: a `.d.ts` file, or a script whose statements are all
 * ambient (`declare ...`, interfaces, type aliases), such as `vite-env.d.ts` or `declare const __APP_VERSION__`.
 */
function isAmbientFile(ts: TypeScript, sourceFile: TS.SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return true;
  if (ts.isExternalModule(sourceFile) || sourceFile.statements.length === 0) return false;
  return sourceFile.statements.every((statement) => {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    return modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
  });
}

/** One entry when the file is a script whose top-level declarations are global. Undefined for modules. */
function scriptGlobals(context: Context, sourceFile: TS.SourceFile, ambient: boolean): Global | undefined {
  const { ts } = context;
  if (ts.isExternalModule(sourceFile)) return undefined;
  // Binding fills `locals` and marks CommonJS files. A CommonJS file keeps its declarations to itself.
  void context.checker;
  const bound = sourceFile as { locals?: ReadonlyMap<string, TS.Symbol>; commonJsModuleIndicator?: TS.Node };
  if (bound.commonJsModuleIndicator !== undefined) return undefined;

  // Names that start with a quote are ambient modules (`declare module 'x'`). One that points at project code
  // is reported as an import; the others describe packages and are reached through a package import.
  const symbols = [...(bound.locals?.values() ?? [])].filter((symbol) => !symbol.name.startsWith('"'));
  const declarations = symbols
    .map((symbol) => ({ name: symbol.name, position: Math.min(...(symbol.declarations ?? []).map((d) => d.getStart(sourceFile))) }))
    .filter((entry) => Number.isFinite(entry.position))
    .sort((a, b) => a.position - b.position);
  if (declarations.length === 0) return undefined;
  const names = declarations.map((d) => d.name);
  const listed = names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
  const line = context.lineAt(sourceFile, declarations[0]!.position);
  if (ambient) {
    return {
      line,
      message: `this file is not a module, so its ambient declarations (${listed}) are global and any file can use them without an import. ${MOVE_AMBIENT}`,
    };
  }
  return {
    line,
    message: `this file is not a module, so its top-level declarations (${listed}) are global and any file can use them without an import. Add an import or export, or \`export {}\`, to make it a module, and import the declarations where they are used.`,
  };
}

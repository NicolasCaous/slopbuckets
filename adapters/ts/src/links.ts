// Source-code links: a folder `<bucket>/_/links/<name>` that holds another project's root folder, through a
// junction or symlink, or as a plain copy of its source files.
//
// analyze maps each origin alias to its link folder and loads the `.external.ts` files of every link into the
// same program as the project, so the project's imports into a link resolve and type-check. For each link it
// reports the symbols the `.external.ts` files publish, the packages the linked files import and whatever kept it
// from reading the link. Linked files are never analyzed as code: the origin's own check covers them.

import { readdirSync, statSync, lstatSync, type Dirent } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import type * as TS from 'typescript';
import { packageName, realPath, typesPackage, type Context, type LinkFolder } from './context.js';
import { flatten, type TypeScript } from './env.js';
import type { LinkDependency, LinkExport, LinkProblem, LinkReport, LinkRequest } from './protocol.js';
import { SignatureHasher } from './signature.js';

const EXTERNAL = '.external.ts';
const BUILTINS = new Set(builtinModules);

export interface PreparedLink {
  /** The link path as the request gave it, the key of its report. */
  key: string;
  /** Set when the folder exists and its alias can be mapped. */
  folder?: LinkFolder;
  /** The `.external.ts` files, as the file names the program loads them under. */
  entries: string[];
  problems: LinkProblem[];
}

/**
 * Checks each requested link folder and finds its `.external.ts` files before the program exists. Adds to `reads`
 * the `dmz/<bucket>/.external.ts` paths that may hold a published file, so creating one in the origin changes the
 * analysis inputs.
 */
export function prepareLinks(projectDir: string, ownAlias: string, requests: readonly LinkRequest[], reads: Set<string>): PreparedLink[] {
  const prepared: PreparedLink[] = [];
  const aliases = new Map<string, string>();
  for (const request of requests) {
    const link: PreparedLink = { key: request.path, entries: [], problems: [] };
    prepared.push(link);
    const linkPath = linkFolderPath(request.path);
    const dir = path.resolve(projectDir, linkPath);
    const missing = folderProblem(dir, linkPath);
    if (missing !== undefined) {
      link.problems.push({ message: missing });
      continue;
    }
    if (request.alias === ownAlias) {
      link.problems.push({ message: `the link's alias ${request.alias} is also this project's alias, so imports through it cannot reach the link; the origin needs another alias` });
      continue;
    }
    const taken = aliases.get(request.alias);
    if (taken !== undefined) {
      link.problems.push({ message: `the link's alias ${request.alias} is also the alias of the link ${taken}; two links cannot share an alias` });
      continue;
    }
    aliases.set(request.alias, linkPath);
    const realDir = realPath(dir);
    link.folder = { path: linkPath, alias: request.alias, dir, realDir };

    const found = findExternalFiles(realDir);
    const throughLink = (file: string) => path.join(dir, path.relative(realDir, file));
    for (const candidate of found.candidates) reads.add(throughLink(candidate));
    if (found.files.length === 0) {
      link.problems.push({ message: `${linkPath} has no ${EXTERNAL} file in a dmz/ folder, so it publishes nothing` });
      continue;
    }
    // The compiler keeps the path through a junction for a file it reaches by `paths` or a relative import; it takes
    // the real path only for node_modules lookups. The entries use the same names, so no file is loaded twice.
    link.entries = found.files.map(throughLink);
  }
  return prepared;
}

/** A requested link path with `/` separators and no trailing slash. */
export function linkFolderPath(requested: string): string {
  return requested.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The message for a link folder that cannot be read, or undefined when it is a folder. */
function folderProblem(dir: string, linkPath: string): string | undefined {
  try {
    if (statSync(dir).isDirectory()) return undefined;
    return `${linkPath} is not a folder`;
  } catch {
    try {
      lstatSync(dir);
      return `${linkPath} points to a folder that does not exist`;
    } catch {
      return `the link folder ${linkPath} does not exist`;
    }
  }
}

/**
 * Every `.external.ts` under a `dmz/` folder of the origin's bucket tree, sorted. The walk never enters `_/`, which
 * holds code, nested projects and the origin's own links, nor node_modules, and never follows a symlink.
 * `candidates` are the `dmz/<bucket>/.external.ts` paths where a published file may appear later.
 */
function findExternalFiles(realDir: string): { files: string[]; candidates: string[] } {
  const files: string[] = [];
  const candidates: string[] = [];
  const walk = (dir: string, dmzDepth: number | undefined): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        if (dmzDepth === undefined && entry.name === '_') continue;
        if (dmzDepth === 0) candidates.push(path.join(full, EXTERNAL));
        walk(full, dmzDepth !== undefined ? dmzDepth + 1 : entry.name === 'dmz' ? 0 : undefined);
      } else if (dmzDepth !== undefined && entry.isFile() && entry.name === EXTERNAL) {
        files.push(full);
      }
    }
  };
  walk(realDir, undefined);
  return { files, candidates };
}

/**
 * Folder replacements for the signature hashers. For a link's own hasher, both names of the link folder disappear,
 * so a published symbol hashes the same through a junction and in a copy, wherever the link lives. For the
 * project's hasher, the origin's real folder reads as the path through the link, as a copy would.
 */
export function hasherFolders(folder: LinkFolder, to: string): { dir: string; to: string }[] {
  return [...new Set([folder.dir, folder.realDir])].map((dir) => ({ dir, to }));
}

/** What a link publishes and needs. Runs after the program has loaded the link's entries. */
export function describeLink(context: Context, link: PreparedLink, reads: Set<string>): LinkReport {
  const report: LinkReport = { exports: [], dependencies: [], problems: [...link.problems] };
  const folder = link.folder;
  if (folder === undefined || link.entries.length === 0) return report;
  const { ts, program } = context;
  const hasher = new SignatureHasher(ts, program, context.checker, context.projectDir, hasherFolders(folder, ''));
  const inLink = (fileName: string) => isInside(folder.realDir, realPath(fileName)) || isInside(folder.dir, path.resolve(fileName));
  const where = (fileName: string) => context.linkPath(fileName) ?? fileName.split(path.sep).join('/');

  const entries: TS.SourceFile[] = [];
  for (const entry of link.entries) {
    const sourceFile = program.getSourceFile(entry);
    if (sourceFile === undefined) report.problems.push({ file: where(entry), message: 'TypeScript did not load this file' });
    else entries.push(sourceFile);
  }

  // Files reachable from the entries, with the packages they import.
  const dependencies = new Map<string, { package: string; from: string; real: string; typeOnly: boolean }>();
  const seen = new Set<TS.SourceFile>(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const sourceFile = queue.shift()!;
    const from = where(sourceFile.fileName);
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      const problem: LinkProblem = { file: from, message: `syntax error: ${flatten(ts, diagnostic.messageText)}` };
      if (diagnostic.start !== undefined) problem.line = context.lineAt(sourceFile, diagnostic.start);
      report.problems.push(problem);
    }
    const follow = (fileName: string) => {
      const target = program.getSourceFile(fileName);
      if (target !== undefined && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    };
    for (const { literal, typeOnly } of moduleReferences(ts, sourceFile)) {
      const text = literal.text;
      if (text.startsWith('node:') || BUILTINS.has(text)) continue;
      const resolved = context.resolveModule(sourceFile, literal);
      if (resolved !== undefined && !resolved.isExternalLibraryImport && !inNodeModules(resolved.resolvedFileName)) {
        if (inLink(resolved.resolvedFileName)) {
          follow(resolved.resolvedFileName);
          continue;
        }
      }
      if (isRelative(text) || path.isAbsolute(text) || context.isAlias(text) || context.isLinkAlias(text)) {
        // A file of the origin that the link lacks, such as one a copy left out.
        if (resolved === undefined) report.problems.push({ file: from, line: context.lineAt(sourceFile, literal.getStart(sourceFile)), message: `cannot resolve "${text}"` });
        continue;
      }
      const name = packageName(text);
      if (name === undefined) continue;
      const key = `${name}\0${from}`;
      const known = dependencies.get(key);
      if (known === undefined) dependencies.set(key, { package: name, from, real: realPath(sourceFile.fileName), typeOnly });
      else known.typeOnly &&= typeOnly;
    }
    for (const reference of sourceFile.referencedFiles) {
      const target = path.resolve(path.dirname(sourceFile.fileName), reference.fileName);
      if (inLink(target)) follow(target);
    }
  }
  report.dependencies = [...dependencies.values()]
    .map((d): LinkDependency => {
      // The compiler reads a linked file through the link path, so it looks up packages from the folders of the
      // consumer; Node follows the junction and looks them up from the real path, in the origin. For a copy both
      // paths are the same file.
      const throughLink = isInside(folder.realDir, d.real) ? path.join(folder.dir, path.relative(folder.realDir, d.real)) : d.real;
      // Type checking accepts the @types package alone. A type-only import is erased, so it needs nothing at runtime.
      const resolvedForTypes = findPackage(d.package, throughLink, reads) || findPackage(typesPackage(d.package), throughLink, reads);
      const resolvedAtRuntime = d.typeOnly || findPackage(d.package, d.real, reads);
      return { package: d.package, from: d.from, resolved: resolvedForTypes && resolvedAtRuntime, resolvedForTypes, resolvedAtRuntime };
    })
    .sort((a, b) => compare(a.from, b.from) || compare(a.package, b.package));

  for (const sourceFile of entries) {
    report.exports.push(...publishedSymbols(context, hasher, sourceFile, where(sourceFile.fileName), report.problems));
  }
  return report;
}

/** The named re-exports of one `.external.ts`. Any other statement is a problem: the origin's check rejects it. */
function publishedSymbols(context: Context, hasher: SignatureHasher, sourceFile: TS.SourceFile, file: string, problems: LinkProblem[]): LinkExport[] {
  const { ts } = context;
  const checker = context.checker;
  const exports: LinkExport[] = [];
  for (const statement of sourceFile.statements) {
    const clause = ts.isExportDeclaration(statement) ? statement.exportClause : undefined;
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || clause === undefined || !ts.isNamedExports(clause)) {
      problems.push({ file, line: context.line(sourceFile, statement), message: 'only `export { ... } from` and `export type { ... } from` are read from a published file; this statement is skipped' });
      continue;
    }
    for (const element of clause.elements) {
      const name = element.name.text;
      const line = context.line(sourceFile, element);
      const symbol = checker.getExportSpecifierLocalTargetSymbol(element);
      if (symbol === undefined || isUnknownSymbol(ts, checker, symbol)) {
        const specifier = statement.moduleSpecifier;
        const from = ts.isStringLiteral(specifier) ? `"${specifier.text}"` : 'the module';
        problems.push({ file, line, message: `${from} does not export "${(element.propertyName ?? element.name).text}"` });
        continue;
      }
      exports.push({ file, name, typeOnly: statement.isTypeOnly || element.isTypeOnly, signature: hasher.hash(symbol), line });
    }
  }
  return exports;
}

export function isUnknownSymbol(ts: TypeScript, checker: TS.TypeChecker, symbol: TS.Symbol): boolean {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return target.flags === ts.SymbolFlags.None || target.declarations === undefined || target.declarations.length === 0;
}

/** Every module specifier in a file that loads another module, with whether the statement is type-only. */
function moduleReferences(ts: TypeScript, sourceFile: TS.SourceFile): { literal: TS.StringLiteralLike; typeOnly: boolean }[] {
  const out: { literal: TS.StringLiteralLike; typeOnly: boolean }[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push({ literal: node.moduleSpecifier, typeOnly: node.importClause?.isTypeOnly === true });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push({ literal: node.moduleSpecifier, typeOnly: node.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      out.push({ literal: node.moduleReference.expression, typeOnly: node.isTypeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      out.push({ literal: node.argument.literal, typeOnly: true });
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        out.push({ literal: node.arguments[0] as TS.StringLiteralLike, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/**
 * Looks for `node_modules/<name>` in the folder of `file` and every folder above it, as Node does. Adds each probed
 * `package.json` to `reads`, so installing the package later changes the analysis inputs.
 */
function findPackage(name: string, file: string, reads: Set<string>): boolean {
  let dir = path.dirname(file);
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const folder = path.join(dir, 'node_modules', ...name.split('/'));
      reads.add(path.join(folder, 'package.json'));
      try {
        if (statSync(folder).isDirectory()) return true;
      } catch {
        // not here
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function inNodeModules(fileName: string): boolean {
  return fileName.split(/[\\/]/).includes('node_modules');
}

function isRelative(text: string): boolean {
  return text === '.' || text === '..' || text.startsWith('./') || text.startsWith('../');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

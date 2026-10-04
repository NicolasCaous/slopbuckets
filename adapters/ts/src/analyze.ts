// `analyze`: describes the DMZ files and the imports of the code files.
//
// One ts.Program covers every requested file. The adapter never asks for the
// program's diagnostics, so nothing is type-checked. The checker binds every
// file when it is created; it is queried for the symbols that DMZ files
// re-export, for import bindings in code files and for script files.
//
// The same program holds the files of every requested link (see links.ts):
// the origin's alias is mapped to the link folder, and the link's
// `.external.ts` files are root files, so whatever they reach is loaded too.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type * as TS from 'typescript';
import { analyzeCode } from './code.js';
import { Context, readDeclaredPackages } from './context.js';
import { flatten, loadTypeScript, readProjectConfig, type TypeScript } from './env.js';
import { AdapterEnvironmentError } from './errors.js';
import { describeLink, hasherFolders, isUnknownSymbol, linkFolderPath, prepareLinks } from './links.js';
import { checkBuildFolders, checkCompilerOptions } from './project-config.js';
import { ABI_VERSION, type AnalyzeRequest, type AnalyzeResponse, type DmzExport } from './protocol.js';
import { SignatureHasher } from './signature.js';

export { packageName } from './context.js';

interface CachedSource {
  text: string;
  file: TS.SourceFile;
  /** The analysis that last used it, to drop the files no analysis uses anymore. */
  run: number;
}

/**
 * Parsed files kept between analyses in the same process, as the TypeScript language service keeps them between
 * programs. A long-running process (the `buckets inspect` watcher) checks again after every change, and most files,
 * the TypeScript lib files included, did not change. A file is reused only when its text, the compiler and the
 * options are the same, so the program is the same as one parsed from scratch.
 */
const parsedFiles = new WeakMap<TypeScript, Map<string, CachedSource>>();
let analysisRun = 0;

function reuseSourceFiles(ts: TypeScript, host: TS.CompilerHost, options: TS.CompilerOptions): void {
  let cache = parsedFiles.get(ts);
  if (cache === undefined) {
    cache = new Map();
    parsedFiles.set(ts, cache);
  }
  const files = cache;
  const run = ++analysisRun;
  const settings = JSON.stringify(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const text = shouldCreateNewSourceFile ? undefined : host.readFile(fileName);
    if (text === undefined) return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    const version = typeof languageVersionOrOptions === 'object' ? `${languageVersionOrOptions.languageVersion}|${languageVersionOrOptions.impliedNodeFormat ?? ''}|${languageVersionOrOptions.jsDocParsingMode ?? ''}` : String(languageVersionOrOptions);
    const key = `${settings}\0${version}\0${fileName}`;
    const hit = files.get(key);
    if (hit !== undefined && hit.text === text) {
      hit.run = run;
      return hit.file;
    }
    // As the default host does, with parent pointers (createCompilerHost(options, true)).
    const file = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    files.set(key, { text, file, run });
    return file;
  };
  // Files the previous analyses used and this one did not are dropped once it has run twice without them.
  for (const [key, entry] of files) if (entry.run < run - 2) files.delete(key);
}

export function analyzeProject(projectDir: string, request: AnalyzeRequest): AnalyzeResponse {
  projectDir = path.resolve(projectDir);
  const ts = loadTypeScript(projectDir);
  const reads = new Set<string>();
  const projectConfig = readProjectConfig(ts, projectDir, request.config.root, reads);
  const response = analyzeWith(ts, projectDir, request, projectConfig, reads);
  // package.json is read by readDeclaredPackages and module resolution; it is listed even when it does not exist.
  reads.add(path.join(projectDir, 'package.json'));
  response.inputs = inputList(projectDir, reads);
  return response;
}

/** The files in `reads` as protocol paths: project-relative with `/` inside the project, absolute outside. */
export function inputList(projectDir: string, reads: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const file of reads) {
    const relative = path.relative(projectDir, file);
    out.add(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : path.resolve(file));
  }
  return [...out].sort();
}

function analyzeWith(ts: TypeScript, projectDir: string, request: AnalyzeRequest, projectConfig: ReturnType<typeof readProjectConfig>, reads: Set<string>): AnalyzeResponse {

  const response: AnalyzeResponse = { abi: ABI_VERSION, config: [], dmz: {}, code: {}, toolchain: `typescript@${ts.version}` };
  const configFile = projectConfig.name;
  for (const message of projectConfig.errors) response.config.push({ file: configFile, message });
  if (projectConfig.unchosen !== undefined) {
    response.config.push({ file: configFile, message: projectConfig.unchosen });
  } else {
    for (const message of checkCompilerOptions(projectDir, request.config, projectConfig.options, path.dirname(projectConfig.file))) {
      response.config.push({ file: configFile, message });
    }
    for (const message of checkBuildFolders(projectDir, request.config, projectConfig, request.nestedProjects)) {
      response.config.push({ file: configFile, message });
    }
  }
  const manifest = readDeclaredPackages(projectDir);
  if (manifest.error !== undefined) response.config.push({ file: 'package.json', message: manifest.error });

  const files = [...request.files.dmz, ...request.files.code];
  for (const file of files) {
    if (!existsSync(path.resolve(projectDir, file))) {
      throw new AdapterEnvironmentError('adapter-failed', `adapter-ts: ${file} does not exist`);
    }
  }

  const requestedLinks = request.links ?? [];
  const links = prepareLinks(projectDir, request.config.alias, requestedLinks, reads);
  if (request.links !== undefined) response.links = {};
  // Linked files follow the origin's rules, which its own check applies, so they are not analyzed as code.
  const linkPrefixes = requestedLinks.map((link) => `${linkFolderPath(link.path)}/`);
  const codeFiles = request.files.code.filter((file) => !linkPrefixes.some((prefix) => file.startsWith(prefix)));
  const entries = links.flatMap((link) => link.entries);
  const folders = links.flatMap((link) => (link.folder === undefined ? [] : [link.folder]));

  if (request.files.dmz.length === 0 && codeFiles.length === 0 && entries.length === 0) {
    for (const link of links) response.links![link.key] = { exports: [], dependencies: [], problems: link.problems };
    return response;
  }

  // JavaScript files can import bucket code too, so they are always part of the program.
  // `allowNonTsExtensions` (internal) lets the program load files whose extension is upper case, such as `x.TS`.
  const options: TS.CompilerOptions = { ...projectConfig.options, allowJs: true, noEmit: true, allowNonTsExtensions: true };
  if (folders.length > 0) {
    // An absolute target needs no baseUrl. It replaces the entry that `buckets link add` wrote, which points at the same folder.
    options.paths = { ...options.paths };
    for (const folder of folders) options.paths[`${folder.alias}/*`] = [`${folder.dir.split(path.sep).join('/')}/*`];
  }
  const host = ts.createCompilerHost(options, true);
  // Module resolution reads package.json files through readFile; source files are listed from the program below.
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => {
    reads.add(path.resolve(file));
    return readFile(file);
  };
  // Module resolution asks the same questions about the same paths for every import. The files do not change during
  // one analysis, so each answer is looked up once.
  const memo = <T>(fn: (p: string) => T): ((p: string) => T) => {
    const answers = new Map<string, T>();
    return (p) => {
      if (answers.has(p)) return answers.get(p)!;
      const answer = fn(p);
      answers.set(p, answer);
      return answer;
    };
  };
  host.fileExists = memo(host.fileExists.bind(host));
  if (host.directoryExists) host.directoryExists = memo(host.directoryExists.bind(host));
  if (host.realpath) host.realpath = memo(host.realpath.bind(host));
  reuseSourceFiles(ts, host, options);
  const rootNames = [...request.files.dmz, ...codeFiles].map((file) => path.resolve(projectDir, file));
  const program = ts.createProgram({ rootNames: [...rootNames, ...entries], options, host });
  for (const sourceFile of program.getSourceFiles()) reads.add(path.resolve(sourceFile.fileName));
  const context = new Context(ts, projectDir, request.config.root, request.config.alias, program, host, manifest.declared, folders);

  if (request.files.dmz.length > 0) {
    // A DMZ symbol whose type comes from a junction reads as the path through the link, as it would in a copy.
    const hasher = new SignatureHasher(ts, program, context.checker, projectDir, folders.flatMap((folder) => hasherFolders(folder, `${folder.path}/`)));
    for (const file of request.files.dmz) {
      response.dmz[file] = analyzeDmz(context, hasher, context.sourceFile(file));
    }
  }
  for (const file of codeFiles) {
    response.code[file] = analyzeCode(context, context.sourceFile(file));
  }
  for (const link of links) response.links![link.key] = describeLink(context, link, reads);
  return response;
}

// ---------------------------------------------------------------------------
// DMZ files

const DMZ_ONLY = 'only `export { ... } from` and `export type { ... } from` are allowed in a DMZ file';

function analyzeDmz(context: Context, hasher: SignatureHasher, sourceFile: TS.SourceFile): AnalyzeResponse['dmz'][string] {
  const { ts } = context;
  const checker = context.checker;
  const exports: DmzExport[] = [];
  const violations: { line: number; message: string }[] = [];
  const violation = (node: TS.Node, message: string) => violations.push({ line: context.line(sourceFile, node), message });

  for (const diagnostic of context.program.getSyntacticDiagnostics(sourceFile)) {
    const line = sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    violations.push({ line, message: `syntax error: ${flatten(ts, diagnostic.messageText)}` });
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier === undefined) {
        violation(statement, `export without \`from\` is not allowed in a DMZ file; ${DMZ_ONLY}`);
      } else if (clause === undefined) {
        violation(statement, '`export *` is not allowed in a DMZ file; list each name');
      } else if (ts.isNamespaceExport(clause)) {
        violation(statement, '`export * as` is not allowed in a DMZ file; list each name');
      } else {
        analyzeReexport(statement, clause);
      }
    } else if (ts.isExportAssignment(statement)) {
      violation(statement, '`export default` is not allowed in a DMZ file');
    } else if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      violation(statement, '`import` is not allowed in a DMZ file; re-export with `export { ... } from`');
    } else if (isDeclaration(ts, statement)) {
      const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
      if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        violation(statement, '`export default` is not allowed in a DMZ file');
      } else {
        violation(statement, `declarations are not allowed in a DMZ file; declare it in a \`_/\` folder and re-export it`);
      }
    } else {
      violation(statement, DMZ_ONLY);
    }
  }
  return { exports, violations };

  function analyzeReexport(statement: TS.ExportDeclaration, clause: TS.NamedExports): void {
    const specifier = statement.moduleSpecifier as TS.StringLiteral;
    if (!ts.isStringLiteral(specifier)) return;
    if (!context.isAlias(specifier.text)) {
      violation(statement, `re-export from "${specifier.text}" is not allowed; a DMZ file re-exports project files through the ${context.alias} alias`);
      return;
    }
    const from = context.resolve(sourceFile, specifier);
    if (from === undefined) {
      violation(statement, `cannot resolve "${specifier.text}" to a file in the project`);
      return;
    }
    for (const element of clause.elements) {
      if (element.propertyName !== undefined) {
        violation(element, `renaming with \`as\` is not allowed in a DMZ file (${element.propertyName.text} as ${element.name.text})`);
        continue;
      }
      const name = element.name.text;
      const symbol = checker.getExportSpecifierLocalTargetSymbol(element);
      if (symbol === undefined || isUnknownSymbol(ts, checker, symbol)) {
        violation(element, `${from} does not export "${name}"`);
        continue;
      }
      exports.push({
        name,
        typeOnly: statement.isTypeOnly || element.isTypeOnly,
        from,
        signature: hasher.hash(symbol),
        line: context.line(sourceFile, element),
      });
    }
  }
}

function isDeclaration(ts: TypeScript, statement: TS.Statement): boolean {
  return (
    ts.isVariableStatement(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  );
}

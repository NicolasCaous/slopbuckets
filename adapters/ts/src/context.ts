// What every step of one analysis shares: the program, module resolution,
// real paths and the project's package.json.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type * as TS from 'typescript';
import type { TypeScript } from './env.js';
import { AdapterEnvironmentError } from './errors.js';
import { parseJson } from './json.js';

/** A requested link whose folder exists. */
export interface LinkFolder {
  /** The link folder relative to the project, with `/`, as the request gave it. */
  path: string;
  /** The origin's alias, mapped to the link folder for this analysis. */
  alias: string;
  /** Absolute path of the link folder. For a junction, files under it are reached through the junction. */
  dir: string;
  /** Real path of the link folder: the origin's root folder for a junction, `dir` for a copy. */
  realDir: string;
}

export class Context {
  private readonly cache: TS.ModuleResolutionCache;
  private readonly realProjectDir: string;
  private readonly realRootDir: string;
  private checkerInstance: TS.TypeChecker | undefined;
  /** Real paths already looked up. The files do not change during one analysis, and each import asks several times. */
  private readonly reals = new Map<string, string>();

  constructor(
    readonly ts: TypeScript,
    readonly projectDir: string,
    readonly root: string,
    readonly alias: string,
    readonly program: TS.Program,
    private readonly host: TS.CompilerHost,
    private readonly declared: Set<string>,
    readonly links: readonly LinkFolder[] = [],
  ) {
    this.cache = ts.createModuleResolutionCache(projectDir, (name) => host.getCanonicalFileName(name), program.getCompilerOptions());
    this.realProjectDir = realPath(projectDir);
    this.realRootDir = realPath(path.resolve(projectDir, root));
  }

  private real(file: string): string {
    let real = this.reals.get(file);
    if (real === undefined) {
      real = realPath(file);
      this.reals.set(file, real);
    }
    return real;
  }

  /** The type checker, created on first use. Creating it binds every file of the program. */
  get checker(): TS.TypeChecker {
    this.checkerInstance ??= this.program.getTypeChecker();
    return this.checkerInstance;
  }

  sourceFile(file: string): TS.SourceFile {
    const sourceFile = this.program.getSourceFile(path.resolve(this.projectDir, file));
    if (sourceFile === undefined) {
      throw new AdapterEnvironmentError('adapter-failed', `adapter-ts: TypeScript did not load ${file}; check its extension`);
    }
    return sourceFile;
  }

  line(sourceFile: TS.SourceFile, node: TS.Node): number {
    return this.lineAt(sourceFile, node.getStart(sourceFile));
  }

  lineAt(sourceFile: TS.SourceFile, position: number): number {
    return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  }

  isAlias(specifier: string): boolean {
    return specifier === this.alias || specifier.startsWith(`${this.alias}/`);
  }

  /** True for a specifier that starts with the alias of a requested link. */
  isLinkAlias(specifier: string): boolean {
    return this.links.some((link) => specifier === link.alias || specifier.startsWith(`${link.alias}/`));
  }

  /**
   * The path through a requested link (`<link path>/<path in the origin>`) of a file inside one, or undefined. A file
   * reached through a junction has the origin's real path, outside this project; a copied file is inside it. Both
   * get the same path.
   */
  linkPath(fileName: string): string | undefined {
    const resolved = path.resolve(fileName);
    const real = this.real(fileName);
    for (const link of this.links) {
      for (const [base, file] of [[link.realDir, real], [link.dir, resolved]] as const) {
        const relative = path.relative(base, file);
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        return `${link.path}/${relative.split(path.sep).join('/')}`;
      }
    }
    return undefined;
  }

  isDeclared(packageName: string): boolean {
    return this.declared.has(packageName) || this.declared.has(typesPackage(packageName));
  }

  /**
   * Resolves an alias specifier the way the compiler does. Returns a project-relative path of the
   * real file (symlinks and junctions followed), or undefined when it does not land on a project file.
   */
  resolve(sourceFile: TS.SourceFile, specifier: TS.StringLiteralLike): string | undefined {
    const resolved = this.resolveModule(sourceFile, specifier);
    if (resolved === undefined || resolved.isExternalLibraryImport) return undefined;
    const relative = this.toProjectPath(resolved.resolvedFileName) ?? this.throughLink(resolved);
    if (relative === undefined || relative.split('/').includes('node_modules')) return undefined;
    return relative;
  }

  /**
   * A file reached through a link that `buckets link` created in `<bucket>/_/links/<name>`. The real file lives
   * in another project, outside this one, so the path through the link is returned instead. The CLI accepts a
   * symlink only at a registered link path, so this never reaches code the check does not see.
   */
  private throughLink(resolved: TS.ResolvedModuleFull): string | undefined {
    // With preserveSymlinks the link path is the resolved file name itself; otherwise TypeScript keeps it in originalPath.
    const candidates = [(resolved as { originalPath?: string }).originalPath, resolved.resolvedFileName];
    for (const original of candidates) {
      if (original === undefined) continue;
      for (const base of new Set([this.projectDir, this.realProjectDir])) {
        const relative = path.relative(base, path.resolve(original));
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        const parts = relative.split(path.sep);
        const links = parts.indexOf('links');
        if (links > 0 && parts[links - 1] === '_' && links + 1 < parts.length) return parts.join('/');
      }
    }
    return undefined;
  }

  /**
   * Maps an alias specifier to `<root>/<rest>` without TypeScript. TypeScript does not resolve files it
   * cannot compile, such as `@root/_/logo.svg` or `@root/_/app.css`, even when a `declare module '*.svg'`
   * lets the import type-check. Returns the project-relative path when that file exists. A query
   * (`?url`, `?raw`) is dropped first, as bundlers do.
   */
  mapAlias(specifier: string): string | undefined {
    if (!specifier.startsWith(`${this.alias}/`)) return undefined;
    const rest = specifier.slice(this.alias.length + 1).replace(/\?.*$/, '');
    if (rest === '') return undefined;
    const file = path.resolve(this.projectDir, this.root, rest);
    try {
      if (!statSync(file).isFile()) return undefined;
    } catch {
      return undefined;
    }
    return this.toProjectPath(file) ?? this.toOutsidePath(file);
  }

  /**
   * Resolves a bare specifier, packages included, and returns a path when it lands on a project file
   * instead of an installed package:
   *
   * - inside the root bucket folder: a `file:` dependency, a symlinked package or a `paths` entry can
   *   point a bare specifier at bucket code, so any resolution counts unless the real path is in node_modules;
   * - anywhere else: only a resolution that did not come from node_modules, such as a `paths` entry
   *   (`#shared/*` mapped to `../shared/*`). A file outside the project folder gets a path that starts with `../`.
   */
  resolveLocal(sourceFile: TS.SourceFile, specifier: TS.StringLiteralLike): string | undefined {
    const resolved = this.resolveModule(sourceFile, specifier);
    if (resolved === undefined) return undefined;
    const real = this.real(resolved.resolvedFileName);
    if (isInside(this.realRootDir, real)) {
      // An installed package stays a package, even when the root folder is the project folder itself.
      const relative = this.toProjectPath(real);
      if (relative === undefined || relative.split('/').includes('node_modules')) return undefined;
      return relative;
    }
    if (resolved.isExternalLibraryImport) return undefined;
    const relative = this.toProjectPath(real) ?? this.toOutsidePath(real);
    if (relative === undefined || relative.split('/').includes('node_modules')) return undefined;
    return relative;
  }

  /**
   * Maps a relative file reference such as the first argument of `new URL('./worker.ts', import.meta.url)`
   * to the file it names, relative to `sourceFile`. Returns the project path when the file exists, a path
   * starting with `../` for a file outside the project, or undefined when there is no such file.
   */
  mapRelativeFile(sourceFile: TS.SourceFile, reference: string): string | undefined {
    const file = path.resolve(path.dirname(sourceFile.fileName), reference.replace(/[?#].*$/, ''));
    try {
      if (!statSync(file).isFile()) return undefined;
    } catch {
      return undefined;
    }
    return this.toProjectPath(file) ?? this.toOutsidePath(file);
  }

  /**
   * Project-relative path with `/` separators of the real file behind `fileName`, or undefined outside the project.
   * A file inside a requested link gets its path through the link.
   */
  toProjectPath(fileName: string): string | undefined {
    const through = this.linkPath(fileName);
    if (through !== undefined) return through;
    const relative = path.relative(this.realProjectDir, this.real(fileName));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join('/');
  }

  /** A path that starts with `../` for a file outside the project folder, or undefined on another drive. */
  private toOutsidePath(fileName: string): string | undefined {
    const relative = path.relative(this.realProjectDir, this.real(fileName));
    if (!relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join('/');
  }

  /** Resolves `specifier` from `sourceFile` with the program's options, as the compiler does. */
  resolveModule(sourceFile: TS.SourceFile, specifier: TS.StringLiteralLike): TS.ResolvedModuleFull | undefined {
    const options = this.program.getCompilerOptions();
    const mode = this.program.getModeForUsageLocation(sourceFile, specifier);
    return this.ts.resolveModuleName(specifier.text, sourceFile.fileName, options, this.host, this.cache, undefined, mode).resolvedModule;
  }
}

/** The real path of `file`, following symlinks and junctions. Returns the resolved input when the file cannot be read. */
export function realPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** `lodash/fp` is `lodash`, `@scope/pkg/sub` is `@scope/pkg`. Undefined when the text cannot be a package name. */
export function packageName(specifier: string): string | undefined {
  if (specifier === '' || specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':') || specifier.includes('\\')) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (parts.length < 2 || parts[0] === '@' || parts[1] === '') return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] === '' ? undefined : parts[0];
}

/** `@types/node` for `node`, `@types/babel__core` for `@babel/core`. */
export function typesPackage(name: string): string {
  return `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** The package names in the project's package.json. A missing file declares nothing; an unreadable one is a config problem. */
export function readDeclaredPackages(projectDir: string): { declared: Set<string>; error?: string } {
  const declared = new Set<string>();
  const file = path.join(projectDir, 'package.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { declared };
    return { declared, error: `package.json cannot be read: ${(error as Error).message}` };
  }
  let manifest: unknown;
  try {
    manifest = parseJson(text);
  } catch (error) {
    return { declared, error: `package.json is not valid JSON, so no dependency counts as declared: ${(error as Error).message}` };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { declared, error: 'package.json must contain a JSON object' };
  }
  for (const field of DEPENDENCY_FIELDS) {
    const deps = (manifest as Record<string, unknown>)[field];
    if (deps !== null && typeof deps === 'object') for (const name of Object.keys(deps)) declared.add(name);
  }
  return { declared };
}

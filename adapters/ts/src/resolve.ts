// Module resolution without TypeScript for almost every import. Relative specifiers, tsconfig `paths` and `baseUrl`
// resolve against the sorted file list of the project (binary search, no disk). Node built-ins and npm packages are
// recognized by name. TypeScript loads only for `#imports` without a `paths` entry and for workspace packages (the
// packages that the `workspaces` of package.json or pnpm-workspace.yaml declare, or that node_modules links into the
// project), and its answers are kept in the state.
//
// Each file resolves with the nearest tsconfig.json inside the project, as tsserver does: the one in its folder or
// the closest parent folder up to the project folder. A file with none above it takes the default settings (no paths,
// no baseUrl), and a project with no tsconfig.json at all is the environment error no-tsconfig.
//
// The state is valid while every resolution input keeps its hash: the tsconfig files read (with their `extends`
// chains), package.json, pnpm-workspace.yaml, the package.json of each workspace package and of the typescript used,
// and the marker files that npm, pnpm and yarn write into node_modules at each install. An install therefore starts the
// state over, and the CLI resolves every import again.
//
// Limit: a folder imported by a relative path resolves to its index file, never to the `main` of a package.json inside
// the project.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import type * as TS from 'typescript';
import { loadTypeScript, readProjectConfig, type LoadedTypeScript, type TypeScript } from './env.js';
import { AdapterEnvironmentError } from './errors.js';
import { SOURCE, toPosix } from './paths.js';
import type { ImportTarget, ResolutionInput } from './protocol.js';

/** What the adapter keeps between runs. The CLI stores it in its cache and passes it back; it is plain data. */
export interface AdapterState {
  /** The files read to find the resolution settings, with their hashes. Empty until first read. */
  inputs: ResolutionInput[];
  /** `paths` and `baseUrl` of each tsconfig.json read, by its project-relative folder ('' for the project folder). Null until the state is read. */
  settings: Record<string, Settings> | null;
  /** Workspace package name to its project-relative folder. */
  workspaces: Record<string, string>;
  /** Package names seen: 0 when the package lives outside the project, 1 when node_modules links it into the project. */
  packages: Record<string, 0 | 1>;
  /**
   * Answers of TypeScript that name a project file: `dir\0spec\0mode` for workspace packages and #imports. An
   * unresolved or package answer can change once a file is added, so only the Resolver of one file list keeps it.
   */
  resolved: Record<string, ImportTarget>;
}

interface Settings {
  /** Project-relative folder, '' for the project folder, or null without baseUrl. */
  baseUrl: string | null;
  /** In the order TypeScript tries them: exact patterns first, then by longest prefix. `pattern` as written. */
  paths: { pattern: string; prefix: string; suffix: string; wildcard: boolean; targets: string[] }[];
}

const NO_SETTINGS: Settings = { baseUrl: null, paths: [] };

export function emptyState(): AdapterState {
  return { inputs: [], settings: null, workspaces: {}, packages: {}, resolved: {} };
}

export type ImportKind = 'static' | 'dynamic' | 'require';

const TRY_EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx'];
const SUBST: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts', '.js'],
  '.jsx': ['.tsx', '.d.ts', '.jsx'],
  '.mjs': ['.mts', '.d.mts', '.mjs'],
  '.cjs': ['.cts', '.d.cts', '.cjs'],
};
/** Files that npm, pnpm and yarn (berry and classic) write into node_modules at every install. */
const INSTALL_MARKERS = ['.package-lock.json', '.modules.yaml', '.yarn-state.yml', '.yarn-integrity'];

const isRelative = (s: string): boolean => s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');
const dirOf = (f: string): string => f.slice(0, f.lastIndexOf('/') + 1);

/** Index of `file` in the sorted list, or -1. */
export function indexOf(files: readonly string[], file: string): number {
  let lo = 0;
  let hi = files.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = files[mid]!;
    if (f === file) return mid;
    if (f < file) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** True when some file of the sorted list is inside folder `dir` (no trailing slash). */
function hasFolder(files: readonly string[], dir: string): boolean {
  const prefix = `${dir}/`;
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo < files.length && files[lo]!.startsWith(prefix);
}

/** The package name of a bare specifier: `@scope/pkg` or `pkg`. */
export function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * The hash of a resolution input: two 32-bit FNV-1a passes over the bytes, '' for a file that cannot be read. An
 * install marker is hashed by its mtime and size instead, since a lock file can take megabytes. Not cryptographic; it
 * avoids loading node:crypto.
 */
function hashFile(file: string): string {
  if (INSTALL_MARKERS.includes(path.basename(file))) {
    try {
      const s = statSync(file);
      return `stat:${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return '';
  }
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i]!, 0x01000193);
    b = Math.imul(b ^ bytes[i]!, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** The JSON at `file`, or undefined when it is missing or broken. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The workspace globs of the project: `workspaces` of package.json (a list, or `{ packages }`) and the `packages` list
 * of pnpm-workspace.yaml, read line by line.
 */
function workspaceGlobs(projectDir: string): string[] {
  const globs: string[] = [];
  const pkg = readJson(path.join(projectDir, 'package.json')) as { workspaces?: unknown } | undefined;
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : Array.isArray((ws as { packages?: unknown } | undefined)?.packages) ? (ws as { packages: unknown[] }).packages : [];
  for (const g of list) if (typeof g === 'string') globs.push(g);
  let yaml = '';
  try {
    yaml = readFileSync(path.join(projectDir, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    // no pnpm workspace
  }
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
      if (m) globs.push(m[1]!);
    }
  }
  return globs;
}

/**
 * The folders of the project that a workspace glob names: literal segments, `*` (one folder level) and `**` (any
 * depth, up to 4), never into node_modules or a dot folder. `!` globs take folders out.
 * ponytail: no other glob syntax; a workspace glob with braces or character classes names no folder.
 */
function workspaceFolders(projectDir: string, globs: readonly string[]): string[] {
  const found = new Set<string>();
  const expand = (base: string, segs: string[], depth: number, out: Set<string>) => {
    if (segs.length === 0) {
      out.add(base);
      return;
    }
    const [seg, ...rest] = segs as [string, ...string[]];
    const subdirs = () => {
      try {
        return readdirSync(path.join(projectDir, base), { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
          .map((e) => (base === '' ? e.name : `${base}/${e.name}`));
      } catch {
        return [];
      }
    };
    if (seg === '**') {
      expand(base, rest, depth, out);
      if (depth < 4) for (const d of subdirs()) expand(d, segs, depth + 1, out);
    } else if (seg === '*') for (const d of subdirs()) expand(d, rest, depth, out);
    else if (!/[*?{[]/.test(seg)) expand(base === '' ? seg : `${base}/${seg}`, rest, depth, out);
  };
  for (const glob of globs) {
    const negative = glob.startsWith('!');
    const segs = (negative ? glob.slice(1) : glob).replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
    if (segs.includes('..')) continue;
    const out = new Set<string>();
    expand('', segs, 0, out);
    for (const d of out) {
      if (negative) found.delete(d);
      else found.add(d);
    }
  }
  return [...found].sort();
}

/** One project as the resolver sees it: its folder, its files and the state from earlier runs. */
export class Resolver {
  private readonly root: string;
  /**
   * The project folder as given and as realpath names it, lower case on Windows. TypeScript answers with real paths,
   * which expand links and 8.3 short names (C:/Users/RUNNER~1 becomes C:/Users/runneradmin), so a file of a project
   * opened through either can come back under the other.
   */
  private readonly rootKeys: string[];
  private ts: LoadedTypeScript | undefined;
  /** Compiler options and module resolution cache of each tsconfig folder TypeScript resolved with. */
  private readonly tsConfigs = new Map<string, { options: TS.CompilerOptions; cache: TS.ModuleResolutionCache }>();
  private tsHost: TS.ModuleResolutionHost | undefined;
  /** Answers of TypeScript that do not name a file, valid for this file list only. */
  private readonly misses = new Map<string, ImportTarget>();
  /** The nearest tsconfig folder of each folder, null for none. */
  private readonly nearest = new Map<string, string | null>();
  private readonly tsconfigSet: Set<string> | null;
  private readonly installed = new Map<string, boolean>();
  /** Files simulated as deleted: on disk, but neither listed nor skipped by the listing. */
  deleted: ReadonlySet<string> = new Set();
  /** The lower-case names in each project folder on disk, null for no folder. analyze.ts clears it at each call. */
  readonly listings = new Map<string, Set<string> | null>();

  /**
   * `files` is the sorted file list, or null to look at the disk. `tsconfigs` lists the project-relative folders that
   * hold a tsconfig.json ('' for the project folder), or null to look at the disk. Throws AdapterEnvironmentError.
   */
  constructor(
    readonly projectDir: string,
    readonly files: readonly string[] | null,
    readonly state: AdapterState,
    readonly tsconfigs: readonly string[] | null = null,
  ) {
    this.root = toPosix(path.resolve(projectDir));
    let real = this.root;
    try {
      real = toPosix(realpathSync.native(this.root));
    } catch {
      // no folder yet: only the given path
    }
    this.rootKeys = [...new Set([this.root, real].map((r) => (process.platform === 'win32' ? r.toLowerCase() : r)))];
    this.tsconfigSet = tsconfigs === null ? null : new Set(tsconfigs);
    if (!this.inputsMatch()) this.readState();
  }

  private abs(rel: string): string {
    return path.resolve(this.projectDir, rel);
  }

  /** Project-relative path of an absolute one, or null when it is outside the project or in node_modules. */
  private rel(absolute: string): string | null {
    const p = toPosix(absolute);
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    const root = this.rootKeys.find((k) => key === k || key.startsWith(`${k}/`));
    if (root === undefined) return null;
    const r = p.slice(root.length + 1);
    return /(^|\/)node_modules(\/|$)/.test(r) ? null : r;
  }

  private inputsMatch(): boolean {
    const { inputs, settings } = this.state;
    if (settings === null || inputs.length === 0) return false;
    return inputs.every((input) => hashFile(this.abs(input.path)) === input.hash);
  }

  /** Adds the files read to the inputs, with their hashes. */
  private addInputs(files: Iterable<string>): void {
    const known = new Set(this.state.inputs.map((i) => i.path));
    for (const file of files) {
      const p = this.rel(file) ?? toPosix(path.resolve(file));
      if (known.has(p)) continue;
      known.add(p);
      this.state.inputs.push({ path: p, hash: hashFile(file) });
    }
    this.state.inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Starts the state over: the workspaces, the install markers and the package.json files, and no tsconfig yet. */
  private readState(): void {
    const reads = new Set<string>([path.join(this.projectDir, 'package.json'), path.join(this.projectDir, 'pnpm-workspace.yaml')]);
    const workspaces: Record<string, string> = {};
    for (const folder of workspaceFolders(this.projectDir, workspaceGlobs(this.projectDir))) {
      const file = path.join(this.projectDir, folder, 'package.json');
      if (!existsSync(file)) continue;
      reads.add(file);
      const name = (readJson(file) as { name?: unknown } | undefined)?.name;
      if (typeof name === 'string' && name !== '') workspaces[name] = folder;
    }
    // The install markers of every node_modules folder that Node would look in from the project folder.
    for (let dir = path.resolve(this.projectDir); ; ) {
      for (const marker of INSTALL_MARKERS) reads.add(path.join(dir, 'node_modules', marker));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    this.state.inputs = [];
    this.state.settings = {};
    this.state.workspaces = workspaces;
    this.state.packages = {};
    this.state.resolved = {};
    this.addInputs(reads);
  }

  private loadTs(): LoadedTypeScript {
    if (this.ts === undefined) {
      this.ts = loadTypeScript(this.projectDir);
      this.addInputs(this.ts.files);
    }
    return this.ts;
  }

  /** The project-relative folder of the tsconfig.json nearest to `dir` (a folder with a trailing `/`, or ''), or null. */
  private nearestConfig(dir: string): string | null {
    const folder = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    const known = this.nearest.get(folder);
    if (known !== undefined) return known;
    const here = this.tsconfigSet !== null ? this.tsconfigSet.has(folder) : existsSync(path.join(this.abs(folder), 'tsconfig.json'));
    const slash = folder.lastIndexOf('/');
    const found = here ? folder : folder === '' ? null : this.nearestConfig(slash < 0 ? '' : folder.slice(0, slash));
    this.nearest.set(folder, found);
    return found;
  }

  /**
   * Throws no-tsconfig when the project holds no tsconfig.json anywhere, as far as the resolver can tell: without the
   * list of tsconfig folders, when the project folder has none.
   */
  requireConfig(): void {
    const none = this.tsconfigSet !== null ? this.tsconfigSet.size === 0 : !existsSync(path.join(this.projectDir, 'tsconfig.json'));
    if (!none) return;
    throw new AdapterEnvironmentError(
      'no-tsconfig',
      `adapter-ts: no tsconfig.json exists in ${this.projectDir} or its folders. Every slopbuckets project with code needs one, and a nested project needs its own, because slopbuckets never uses the tsconfig.json of an enclosing project. Create a tsconfig.json in ${this.projectDir}.`,
    );
  }

  /** The settings of the tsconfig nearest to the file `from`. */
  private settingsFor(from: string): { folder: string | null; settings: Settings } {
    const folder = this.nearestConfig(dirOf(from));
    if (folder === null) return { folder, settings: NO_SETTINGS };
    const known = this.state.settings![folder];
    if (known !== undefined) return { folder, settings: known };
    const settings = this.readSettings(folder);
    this.state.settings![folder] = settings;
    return { folder, settings };
  }

  /** Reads `paths` and `baseUrl` of the tsconfig.json in `folder` through TypeScript. */
  private readSettings(folder: string): Settings {
    const { ts } = this.loadTs();
    const reads = new Set<string>();
    const dir = this.abs(folder);
    const config = readProjectConfig(ts, dir, '.', reads);
    this.addInputs(reads);
    const options = config.options as TS.CompilerOptions & { pathsBasePath?: string };
    this.tsConfigs.set(folder, { options: config.options, cache: ts.createModuleResolutionCache(toPosix(dir), (x) => x, { ...config.options, allowJs: true }) });
    const relDir = (abs: string): string => toPosix(path.relative(this.projectDir, abs));
    const base = options.baseUrl ?? options.pathsBasePath ?? dir;
    const paths = Object.entries(options.paths ?? {}).map(([pattern, targets]) => {
      const star = pattern.indexOf('*');
      return {
        pattern,
        prefix: star < 0 ? pattern : pattern.slice(0, star),
        suffix: star < 0 ? '' : pattern.slice(star + 1),
        wildcard: star >= 0,
        targets: targets.map((t) => relDir(path.resolve(base, t))),
      };
    });
    paths.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.prefix.length - a.prefix.length);
    return { baseUrl: options.baseUrl === undefined ? null : relDir(options.baseUrl), paths };
  }

  private exists(rel: string): boolean {
    if (this.files !== null) return indexOf(this.files, rel) >= 0;
    return this.onDisk(rel);
  }

  private isFolder(rel: string): boolean {
    try {
      return statSync(this.abs(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * The lower-case names in a project folder, null when it is no folder. A folder is read only when its parent lists
   * it, so the folder that an import naming no file would have as `<path>/index.ts` costs no system call.
   */
  private listing(folder: string): Set<string> | null {
    let names = this.listings.get(folder);
    if (names !== undefined) return names;
    const slash = folder.lastIndexOf('/');
    names = null;
    if (folder === '' || this.listing(slash < 0 ? '' : folder.slice(0, slash))?.has(folder.slice(slash + 1).toLowerCase())) {
      try {
        names = new Set(readdirSync(this.abs(folder)).map((n) => n.toLowerCase()));
      } catch {
        // Not a folder after all, or unreadable: no file below it counts.
      }
    }
    this.listings.set(folder, names);
    return names;
  }

  private onDisk(rel: string): boolean {
    if (this.deleted.has(rel)) return false;
    // Most paths asked here are misses: the candidates of an import that names no file. The folder listings answer
    // those without a stat each. A name in a listing still goes to statSync, which follows links and compares case as
    // the file system does, so the listings compare in lower case and only rule names out. A path above the project
    // folder has no listing.
    const slash = rel.lastIndexOf('/');
    if (!rel.startsWith('../') && !this.listing(slash < 0 ? '' : rel.slice(0, slash))?.has(rel.slice(slash + 1).toLowerCase())) return false;
    try {
      return statSync(this.abs(rel)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * A project-relative path as TypeScript completes it: extension substitution, extensions, then index files. A path
   * that ends in `/`, `.` or `..` names a folder, so only its index file counts. `exists` decides which files count.
   */
  private lookup(p: string, exists: (rel: string) => boolean = (r) => this.exists(r)): string | null {
    const folderOnly = /(^|\/)\.{0,2}$/.test(p);
    p = path.posix.normalize(p);
    if (p.endsWith('/')) p = p.slice(0, -1);
    if (p === '.') p = '';
    if (p.startsWith('../') || p === '..' || path.posix.isAbsolute(p)) return null;
    const index = (dir: string): string | null => {
      const stem = dir === '' ? 'index' : `${dir}/index`;
      for (const e of TRY_EXT) if (exists(stem + e)) return stem + e;
      return null;
    };
    if (folderOnly) return index(p);
    const ext = path.posix.extname(p);
    const subst = SUBST[ext];
    if (subst !== undefined) {
      const stem = p.slice(0, -ext.length);
      for (const e of subst) if (exists(stem + e)) return stem + e;
      return null;
    }
    if (/\.([cm]?ts|tsx)$/.test(p)) return exists(p) ? p : null;
    if (p !== '') for (const e of TRY_EXT) if (exists(p + e)) return p + e;
    return index(p);
  }

  /**
   * A path that is no listed file: `kind` when nothing on disk answers it either, else other, because the file exists
   * but the listing leaves it out (git ignores it, as for generated code), or it is no source file, such as the
   * stylesheet of `import './app.css'` that a bundler loads. A stylesheet, JSON file, image or other asset is no code
   * edge: the engine lists only source files, so it has no owner or exports to check. A bundler query such as `?raw`
   * or `?url` is dropped first, which a `paths` specifier such as '@/logo.svg?url' still carries.
   */
  private missing(p: string, kind: 'relative' | 'paths', pattern?: string): ImportTarget {
    const file = p.replace(/\?.*$/, '');
    if (this.onDisk(path.posix.normalize(file)) || this.lookup(file, (r) => this.onDisk(r)) !== null) return { unresolved: 'other' };
    return pattern === undefined ? { unresolved: kind } : { unresolved: kind, pattern };
  }

  /** Where `spec`, imported by the project file `from`, points. */
  resolve(from: string, spec: string, kind: ImportKind): ImportTarget {
    if (spec === '') return { unresolved: 'other' };
    if (isRelative(spec)) {
      // A bundler query, as in `import text from './x.js?raw'`, loads the file before the `?`.
      const p = dirOf(from) + spec.replace(/\?.*$/, '');
      const hit = this.lookup(p);
      return hit !== null ? { file: hit } : this.missing(p, 'relative');
    }
    if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) return { unresolved: 'other' };
    if (spec.startsWith('node:')) return { builtin: spec };
    const { folder, settings } = this.settingsFor(from);
    for (const p of settings.paths) {
      if (p.wildcard ? !(spec.length >= p.prefix.length + p.suffix.length && spec.startsWith(p.prefix) && spec.endsWith(p.suffix)) : spec !== p.prefix) continue;
      const captured = p.wildcard ? spec.slice(p.prefix.length, spec.length - p.suffix.length) : '';
      for (const target of p.targets) {
        const hit = this.lookup(target.replace('*', captured));
        if (hit !== null) return { file: hit };
      }
      // TypeScript uses only the best matching pattern, and then looks in node_modules. A pattern that is only `*`
      // catches every package name, so its misses are packages.
      if (p.prefix === '' && p.suffix === '' && p.wildcard) break;
      if (!isBuiltin(spec) && !this.isInstalled(from, packageName(spec)) && !(packageName(spec) in this.state.workspaces)) {
        const t = p.targets[0];
        return this.missing(t === undefined ? spec : t.replace('*', captured), 'paths', p.pattern);
      }
      break;
    }
    if (settings.baseUrl !== null) {
      const target = this.underBaseUrl(from, spec, settings.baseUrl);
      if (target !== null) return target;
    }
    const mode = kind === 'require' ? 'r' : 'i';
    if (spec.startsWith('#')) return this.viaTs(`${dirOf(from)}\0${spec}\0${mode}`, from, folder, spec, kind, { unresolved: 'other' });
    if (isBuiltin(spec)) return { builtin: spec };
    const name = packageName(spec);
    if (name in this.state.workspaces) return this.viaTs(`${dirOf(from)}\0${spec}\0${mode}`, from, folder, spec, kind, { unresolved: 'workspace' });
    const linked = (this.state.packages[name] ??= this.isLinked(name));
    if (linked === 0) return { package: name };
    return this.viaTs(`${dirOf(from)}\0${spec}\0${mode}`, from, folder, spec, kind, { unresolved: 'workspace' });
  }

  /**
   * The file `spec` names under `baseUrl`, or null to look on as for a package. A first segment that is a folder under
   * baseUrl and no installed package, as 'src/x' with baseUrl '.', names a project file that is not there, not an npm
   * package called src, so it is a paths miss without a pattern.
   */
  private underBaseUrl(from: string, spec: string, baseUrl: string): ImportTarget | null {
    const p = baseUrl === '' ? spec : `${baseUrl}/${spec}`;
    const hit = this.lookup(p);
    if (hit !== null) return { file: hit };
    const name = packageName(spec);
    if (!spec.includes('/') || name.startsWith('@') || isBuiltin(spec) || name in this.state.workspaces) return null;
    if (!this.isFolder(baseUrl === '' ? name : `${baseUrl}/${name}`) || this.isInstalled(from, name)) return null;
    return this.missing(p, 'paths');
  }

  /** True when node_modules/<name> exists in the folder of `from` or a folder above it. */
  private isInstalled(from: string, name: string): boolean {
    const key = `${dirOf(from)}\0${name}`;
    let known = this.installed.get(key);
    if (known === undefined) {
      known = false;
      for (let dir = path.dirname(this.abs(from)); ; ) {
        if (existsSync(path.join(dir, 'node_modules', name))) {
          known = true;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      this.installed.set(key, known);
    }
    return known;
  }

  /** 1 when node_modules/<name> in the project folder or above it is a link into the project. */
  private isLinked(name: string): 0 | 1 {
    for (let dir = this.projectDir; ; ) {
      const candidate = path.join(dir, 'node_modules', name);
      try {
        if (!lstatSync(candidate).isSymbolicLink()) return 0;
        return this.rel(realpathSync.native(candidate)) === null ? 0 : 1;
      } catch {
        // not here: look one folder up
      }
      const parent = path.dirname(dir);
      if (parent === dir) return 0;
      dir = parent;
    }
  }

  /** TypeScript's answer for `spec` from `from`, with the settings of the tsconfig in `folder`; `miss` when it names no project file. */
  private viaTs(key: string, from: string, folder: string | null, spec: string, kind: ImportKind, miss: ImportTarget): ImportTarget {
    const known = this.state.resolved[key] ?? this.misses.get(key);
    if (known !== undefined) return known;
    const { ts } = this.loadTs();
    const configKey = folder ?? '';
    let config = this.tsConfigs.get(configKey);
    if (config === undefined) {
      const options = folder === null ? {} : readProjectConfig(ts, this.abs(folder), '.').options;
      config = { options, cache: ts.createModuleResolutionCache(toPosix(this.abs(configKey)), (x) => x, { ...options, allowJs: true }) };
      this.tsConfigs.set(configKey, config);
    }
    const options = { ...config.options, allowJs: true };
    this.tsHost ??= this.makeHost(ts);
    const mode = kind === 'require' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
    const r = ts.resolveModuleName(spec, this.abs(from), options, this.tsHost, config.cache, undefined, mode).resolvedModule;
    let target: ImportTarget = miss;
    if (r !== undefined) {
      const rel = this.rel(r.resolvedFileName);
      if (rel !== null && this.exists(rel)) target = { file: rel };
      // A package installed from npm under the name of no workspace: an ordinary package.
      else if (rel === null && !('unresolved' in miss && miss.unresolved === 'workspace')) target = spec.startsWith('#') ? miss : { package: packageName(spec) };
    }
    if ('file' in target) this.state.resolved[key] = target;
    else this.misses.set(key, target);
    return target;
  }

  /** A host that answers "does this source file or folder exist" inside the project from the file list. */
  private makeHost(ts: TypeScript): TS.ModuleResolutionHost {
    const files = this.files;
    const inProject = (p: string): string | null => (files === null ? null : this.rel(p));
    return {
      fileExists: (p) => {
        const r = SOURCE.test(p) ? inProject(p) : null;
        return r === null ? ts.sys.fileExists(p) : indexOf(files!, r) >= 0;
      },
      directoryExists: (p) => {
        const r = inProject(p.endsWith('/') ? p.slice(0, -1) : p);
        return r === null ? ts.sys.directoryExists(p) : r === '' || hasFolder(files!, r);
      },
      readFile: ts.sys.readFile,
      realpath: ts.sys.realpath!,
      getCurrentDirectory: () => this.root,
    };
  }
}

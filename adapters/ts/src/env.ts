// Loads the project's own `typescript` package and reads its tsconfig.json.
// The adapter never bundles typescript: every value comes from the project at runtime,
// and this file only imports its types.

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TS from 'typescript';
import { AdapterEnvironmentError } from './errors.js';

export type TypeScript = typeof TS;

const loaded = new Map<string, TypeScript>();

/** Loads `typescript` as the project would resolve it, starting from `projectDir`. */
export function loadTypeScript(projectDir: string): TypeScript {
  let projectRequire = createRequire(path.join(path.resolve(projectDir), 'package.json'));
  let resolved: string;
  try {
    try {
      resolved = projectRequire.resolve('typescript');
    } catch (error) {
      // Node reads the project's package.json while resolving. When that file is broken, look up
      // node_modules from the project folder without it; analyze reports the broken file.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_PACKAGE_CONFIG') throw error;
      projectRequire = createRequire(import.meta.url);
      resolved = projectRequire.resolve('typescript', { paths: [path.resolve(projectDir)] });
    }
  } catch {
    throw new AdapterEnvironmentError(
      'no-typescript',
      `adapter-ts: the project at ${projectDir} has no "typescript" package. Install it with "npm install --save-dev typescript".`,
    );
  }
  let ts = loaded.get(resolved);
  if (ts === undefined) {
    ts = projectRequire(resolved) as TypeScript;
    loaded.set(resolved, ts);
  }
  return ts;
}

export function tsconfigPath(projectDir: string): string {
  const file = path.join(projectDir, 'tsconfig.json');
  if (!existsSync(file)) {
    throw new AdapterEnvironmentError(
      'no-tsconfig',
      `adapter-ts: ${file} does not exist. Every slopbuckets project needs a tsconfig.json in its own folder, and so does a nested project, because slopbuckets never uses the tsconfig.json of an enclosing project. Create a tsconfig.json in ${projectDir}, then run \`buckets init\` there to add the alias and noUnusedLocals.`,
    );
  }
  return file;
}

export interface ProjectConfig {
  /** Absolute path of the config that was read. */
  file: string;
  /** The same config as a project-relative path with `/`, such as "tsconfig.json" or "tsconfig.app.json". */
  name: string;
  options: TS.CompilerOptions;
  /** Problems found while reading the config, already formatted as messages. */
  errors: string[];
  /**
   * Set when tsconfig.json is a solution-style config and none of its references is the app config:
   * what a human has to do. The options then come from tsconfig.json itself.
   */
  unchosen?: string;
  /** True when the chosen config came from `references` and its `include` does not cover the root folder yet. */
  missesRoot?: boolean;
  /** Which files the config puts in the build. Absent when the config could not be read. */
  coverage?: ConfigCoverage;
}

/** The effective `files`, `include` and `exclude` of a config, after `extends`. */
export interface ConfigCoverage {
  /** The `files` entries, absolute. */
  files: string[];
  /** The `include` patterns with the `exclude` patterns that apply to them, both relative to `basePath`. */
  patterns: { basePath: string; includes: readonly string[]; excludes: readonly string[] }[];
  caseSensitive: boolean;
}

/** How a config reaches a folder: through a `files` entry, through `include`, or not at all. */
export type FolderReach = 'files' | 'include' | 'excluded' | 'none';

/**
 * How the config reaches the folder `dir` (absolute). TypeScript lists files only when it builds, so `include` is
 * tested with probe files in the folder: `index.ts` and `_/index.ts`, also as `.tsx`. `excluded` means `include`
 * matches a probe but `exclude` leaves every matching probe out.
 */
export function folderReach(coverage: ConfigCoverage, dir: string): FolderReach {
  const folder = `${toPosix(dir)}/`;
  const { caseSensitive } = coverage;
  const inside = (f: string) => (caseSensitive ? f.startsWith(folder) : f.toLowerCase().startsWith(folder.toLowerCase()));
  if (coverage.files.some((f) => inside(toPosix(path.resolve(f))))) return 'files';
  const probes = ['index.ts', 'index.tsx', '_/index.ts', '_/index.tsx'].map((name) => folder + name);
  let excluded = false;
  for (const { basePath, includes, excludes } of coverage.patterns) {
    for (const probe of probes) {
      if (!includes.some((spec) => includeMatches(spec, basePath, probe, caseSensitive))) continue;
      if (excludes.some((spec) => excludeMatches(spec, basePath, probe, caseSensitive))) excluded = true;
      else return 'include';
    }
  }
  return excluded ? 'excluded' : 'none';
}

// TS18003 "No inputs were found in config file". The adapter never globs the
// project's files, so this error is always present and means nothing here.
const NO_INPUTS = 18003;

/**
 * Reads the project's TypeScript config (comments, trailing commas and `extends` included) without listing
 * the project's files. Usually that is tsconfig.json. When tsconfig.json is a solution-style config (`"files": []`,
 * or neither `files` nor `include`, plus `references`), the settings live in a referenced config: the first one
 * whose `include` or `files` covers the root folder, or else the first app config such as tsconfig.app.json.
 */
/** A `readFile` that adds every file it is asked for to `reads`, so a caller can list the files a step read. */
export function recordingReadFile(ts: TypeScript, reads: Set<string> | undefined): (file: string, encoding?: string) => string | undefined {
  if (reads === undefined) return ts.sys.readFile;
  return (file, encoding) => {
    reads.add(path.resolve(file));
    return ts.sys.readFile(file, encoding);
  };
}

/**
 * `reads`, when given, receives the absolute path of every config file read: tsconfig.json, the configs it
 * references and every config in an `extends` chain.
 */
export function readProjectConfig(ts: TypeScript, projectDir: string, root: string, reads?: Set<string>): ProjectConfig {
  const readFile = recordingReadFile(ts, reads);
  const main = tsconfigPath(projectDir);
  const read = ts.readConfigFile(main, readFile);
  if (read.error !== undefined) {
    return { file: main, name: 'tsconfig.json', options: {}, errors: [flatten(ts, read.error.messageText)] };
  }
  const references = solutionReferences(projectDir, read.config);
  if (references.length === 0) return parseConfig(ts, projectDir, main, read.config, readFile).config;

  const rootDir = path.resolve(projectDir, root);
  const candidates: { config: ProjectConfig; covers: boolean }[] = [];
  for (const file of references) {
    const referenced = ts.readConfigFile(file, readFile);
    if (referenced.error !== undefined) continue;
    const parsed = parseConfig(ts, projectDir, file, referenced.config, readFile);
    candidates.push({ config: parsed.config, covers: parsed.covers(rootDir) });
  }
  const covering = candidates.find((c) => c.covers);
  if (covering !== undefined) return covering.config;
  const app = candidates.find((c) => /\bapp\b/i.test(path.basename(c.config.file)));
  if (app !== undefined) return { ...app.config, missesRoot: true };

  const names = references.map((file) => `"${toPosix(path.relative(projectDir, file))}"`).join(', ');
  const fallback = parseConfig(ts, projectDir, main, read.config, readFile).config;
  return {
    ...fallback,
    unchosen: `tsconfig.json is a solution-style config whose references (${names}) hold the compiler settings, and none of them includes ${toPosix(root)}/ or is named like an app config (tsconfig.app.json). Add ${toPosix(root)}/ to the "include" of the referenced config that compiles the app, then run \`buckets init\` again so that it edits that file`,
  };
}

/** The referenced config files when tsconfig.json is a solution-style config, else an empty list. */
function solutionReferences(projectDir: string, raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const config = raw as { files?: unknown; include?: unknown; references?: unknown };
  if (!Array.isArray(config.references) || config.references.length === 0 || config.include !== undefined) return [];
  if (config.files !== undefined && !(Array.isArray(config.files) && config.files.length === 0)) return [];
  const files: string[] = [];
  for (const reference of config.references as unknown[]) {
    const target = (reference as { path?: unknown } | null)?.path;
    if (typeof target !== 'string') continue;
    let file = path.resolve(projectDir, target);
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'tsconfig.json');
    } catch {
      continue;
    }
    if (existsSync(file) && !files.includes(file)) files.push(file);
  }
  return files;
}

/** Parses one config file. `covers` tells whether its `files` or `include` reach a code file in a folder. */
function parseConfig(
  ts: TypeScript,
  projectDir: string,
  file: string,
  raw: unknown,
  readFile: (file: string, encoding?: string) => string | undefined = ts.sys.readFile,
): { config: ProjectConfig; covers(dir: string): boolean } {
  const caseSensitive = ts.sys.useCaseSensitiveFileNames;
  const patterns: ConfigCoverage['patterns'] = [];
  const host: TS.ParseConfigHost = {
    useCaseSensitiveFileNames: caseSensitive,
    // TypeScript asks for the files that match `include`. Nothing is listed; the patterns are kept for `coverage`.
    readDirectory: (basePath, _extensions, excludes, includes) => {
      patterns.push({ basePath, includes: includes ?? [], excludes: excludes ?? [] });
      return [];
    },
    fileExists: ts.sys.fileExists,
    // `extends` chains are read through this, so the caller sees every config in them.
    readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(raw, host, path.dirname(file), undefined, file);
  const errors: string[] = [];
  for (const diagnostic of parsed.errors) {
    if (diagnostic.code !== NO_INPUTS) errors.push(flatten(ts, diagnostic.messageText));
  }
  const name = toPosix(path.relative(projectDir, file));
  const coverage: ConfigCoverage = { files: parsed.fileNames.map((f) => path.resolve(f)), patterns, caseSensitive };
  return {
    config: { file, name, options: parsed.options, errors, coverage },
    covers: (dir) => {
      const reach = folderReach(coverage, dir);
      return reach === 'files' || reach === 'include';
    },
  };
}

/** True when the tsconfig `include` pattern `spec`, relative to `basePath`, matches the absolute `/`-separated `file`. */
export function includeMatches(spec: string, basePath: string, file: string, caseSensitive: boolean): boolean {
  let pattern = toPosix(path.resolve(basePath, spec));
  const last = pattern.slice(pattern.lastIndexOf('/') + 1);
  // As in TypeScript, a last segment with neither a wildcard nor an extension names a folder and includes all of it.
  if (!/[*?]/.test(last) && !last.includes('.')) pattern += '/**/*';
  const segments = pattern.split('/');
  let source = '';
  segments.forEach((segment, i) => {
    if (segment === '**') {
      source += '(?:[^/]+/)*';
      return;
    }
    source += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (i < segments.length - 1) source += '/';
  });
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i').test(file);
}

/**
 * True when the tsconfig `exclude` pattern `spec`, relative to `basePath`, leaves out the absolute `/`-separated
 * `file`. As in TypeScript, a pattern excludes what it matches and everything below it, and a trailing `**`
 * means the folder itself.
 */
export function excludeMatches(spec: string, basePath: string, file: string, caseSensitive: boolean): boolean {
  let pattern = toPosix(path.resolve(basePath, spec));
  while (pattern.endsWith('/**')) pattern = pattern.slice(0, -3);
  const segments = pattern.split('/');
  let source = '';
  segments.forEach((segment, i) => {
    if (segment === '**') {
      source += '(?:[^/]+/)*';
      return;
    }
    source += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (i < segments.length - 1) source += '/';
  });
  return new RegExp(`^${source}(?:/|$)`, caseSensitive ? '' : 'i').test(file);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function flatten(ts: TypeScript, message: string | TS.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, '\n');
}

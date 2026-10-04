// Analysis cache: the adapter's answers for each project, keyed by a hash of every input the analysis reads. A
// project whose inputs did not change skips the adapter. `buckets check` keeps the cache in `.buckets/cache/` of the
// project where it ran; `buckets refresh --web` keeps one in memory, so its page requests write nothing to disk.
//
// The key has two parts. The first is computed before the analysis: the request, the text of every requested
// file, the names of the other files under `_/`, the usual project config files, the compiler version, the link
// folders and the versions. The second covers the files the adapter reports in `inputs` (the tsconfig `extends`
// chain, referenced configs, package.json files, `.d.ts` files outside the root folder, type packages): it is
// stored with the entry and recomputed on every read. An answer without `inputs` is never cached.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256, textHash } from './hash.js';
import { CONFIG_FILE } from './paths.js';
import type { LinkedAnalyzeRequest as AnalyzeRequest, LinkedAnalyzeResponse as AnalyzeResponse } from './types.js';

export const CACHE_DIR = path.join('.buckets', 'cache');
const CACHE_VERSION = 3;

/** Project files outside the code and DMZ lists that change how the adapter reads the project. */
const PROJECT_INPUTS = [CONFIG_FILE, 'tsconfig.json', 'jsconfig.json', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];

export interface CacheEntry {
  version: number;
  key: string;
  /** Fingerprint of the files in `analyze.inputs` when the entry was written. */
  inputs: string;
  analyze: AnalyzeResponse;
}

/** Where cache entries live. `diskCache` is the `.buckets/cache/` folder; `memoryCache` keeps entries in a Map. */
export interface CacheStore {
  read(projectDir: string): unknown;
  write(projectDir: string, entry: CacheEntry): void;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The version of the compiler the project resolves, which can change hashes. */
function typescriptVersion(projectDir: string): string {
  try {
    const file = createRequire(path.join(projectDir, 'package.json')).resolve('typescript/package.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'none';
  }
}

let buildId: string | undefined;

/**
 * Size and modification time of the running CLI code. A local build of the same version changes it, so an answer
 * cached by an older build of the rules or the adapter is not reused.
 */
function buildFingerprint(): string {
  if (buildId === undefined) {
    try {
      const stat = statSync(fileURLToPath(import.meta.url));
      buildId = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      buildId = 'unknown';
    }
  }
  return buildId;
}

/** The first part of the key, computed before the analysis runs. */
export function analysisKey(input: {
  projectDir: string;
  request: AnalyzeRequest;
  otherFiles: string[];
  links: Record<string, string | null>;
  versions: string[];
  /** Filled with the text hash of each file read, by absolute path, so `lookupCache` does not read them again. */
  hashes?: Map<string, string>;
}): string {
  const files: Record<string, string | null> = {};
  for (const file of [...input.request.files.code, ...input.request.files.dmz]) {
    const abs = path.join(input.projectDir, file);
    const text = readText(abs);
    files[file] = text === null ? null : textHash(text);
    if (text !== null) input.hashes?.set(path.resolve(abs), files[file]!);
  }
  const project: Record<string, string | null> = {};
  for (const file of PROJECT_INPUTS) {
    const text = readText(path.join(input.projectDir, file));
    project[file] = text === null ? null : textHash(text);
  }
  return sha256(
    canonicalJson({
      v: CACHE_VERSION,
      request: input.request,
      files,
      other: input.otherFiles,
      project,
      typescript: typescriptVersion(input.projectDir),
      links: input.links,
      versions: input.versions,
      build: buildFingerprint(),
    }),
  );
}

function isInsideProject(projectDir: string, file: string): boolean {
  const relative = path.relative(projectDir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The second part of the key: the state of every file the adapter read. Files inside the project count by their
 * text, files outside it (node_modules, the TypeScript lib files, a tsconfig shared by several projects) by size and
 * modification time, which is enough to see an install or an edit and costs one stat per file. A missing file counts
 * as missing, so creating it changes the fingerprint.
 */
export function inputsFingerprint(projectDir: string, inputs: readonly string[], hashes?: ReadonlyMap<string, string>): string {
  const state: string[] = [];
  for (const input of [...inputs].sort()) {
    const abs = path.resolve(projectDir, input);
    let line: string;
    try {
      const stat = statSync(abs, { bigint: true });
      if (!stat.isFile()) line = 'not-a-file';
      else if (isInsideProject(projectDir, abs) && !abs.split(path.sep).includes('node_modules')) line = hashes?.get(abs) ?? textHash(readFileSync(abs, 'utf8'));
      else line = `${stat.size}:${stat.mtimeNs}`;
    } catch {
      line = 'missing';
    }
    state.push(`${input}\0${line}`);
  }
  return sha256(state.join('\n'));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when `value` has the shape of an analyze answer, so a hand-edited or truncated entry is ignored. */
function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
  if (!isObject(value) || typeof value.abi !== 'number' || !Array.isArray(value.config)) return false;
  if (!isObject(value.dmz) || !isObject(value.code)) return false;
  if (!Array.isArray(value.inputs) || !value.inputs.every((i) => typeof i === 'string')) return false;
  for (const entry of Object.values(value.dmz)) if (!isObject(entry) || !Array.isArray(entry.exports) || !Array.isArray(entry.violations)) return false;
  for (const entry of Object.values(value.code)) if (!isObject(entry) || !Array.isArray(entry.imports)) return false;
  if (value.links !== undefined) {
    if (!isObject(value.links)) return false;
    for (const entry of Object.values(value.links)) {
      if (!isObject(entry) || !Array.isArray(entry.exports) || !Array.isArray(entry.dependencies) || !Array.isArray(entry.problems)) return false;
    }
  }
  return true;
}

/**
 * The entry for `key`, when it exists, has the right version and shape, and its inputs did not change. `hashes` holds
 * text hashes that `analysisKey` computed moments before in the same check, so those files are not read twice.
 */
export function lookupCache(store: CacheStore, projectDir: string, key: string, hashes?: ReadonlyMap<string, string>): CacheEntry | null {
  let raw: unknown;
  try {
    raw = store.read(projectDir);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== CACHE_VERSION || raw.key !== key || typeof raw.inputs !== 'string') return null;
  if (!isAnalyzeResponse(raw.analyze)) return null;
  const entry = raw as unknown as CacheEntry;
  if (inputsFingerprint(projectDir, entry.analyze.inputs!, hashes) !== entry.inputs) return null;
  return entry;
}

/**
 * A new entry, or null when the answer has no `inputs`, which makes it impossible to tell when it goes stale.
 * `hashes` are the text hashes `analysisKey` read before the analysis. Reusing them also keeps the entry honest when
 * a file changes during the analysis: the entry then records the text the key was made from, so the next lookup sees
 * the change and analyzes again.
 */
export function makeCacheEntry(projectDir: string, key: string, analyze: AnalyzeResponse, hashes?: ReadonlyMap<string, string>): CacheEntry | null {
  if (!Array.isArray(analyze.inputs)) return null;
  return { version: CACHE_VERSION, key, inputs: inputsFingerprint(projectDir, analyze.inputs, hashes), analyze };
}

function entryFile(cacheDir: string, projectDir: string): string {
  return path.join(cacheDir, `${sha256(path.resolve(projectDir)).slice('sha256:'.length, 'sha256:'.length + 24)}.json`);
}

/** The cache in a folder, one JSON file per project. A cache that cannot be written (read-only folder) is skipped. */
export function diskCache(cacheDir: string): CacheStore {
  return {
    read(projectDir) {
      const text = readText(entryFile(cacheDir, projectDir));
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    write(projectDir, entry) {
      try {
        mkdirSync(cacheDir, { recursive: true });
        // `.buckets/` holds only local state, so it ignores itself without touching the project's .gitignore.
        const ignore = path.join(path.dirname(cacheDir), '.gitignore');
        if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
        writeFileSync(entryFile(cacheDir, projectDir), JSON.stringify(entry), 'utf8');
      } catch {
        // The cache only saves time.
      }
    },
  };
}

/** A cache that lives as long as the process, for servers whose requests must not write files. */
export function memoryCache(): CacheStore {
  const entries = new Map<string, CacheEntry>();
  return {
    read: (projectDir) => entries.get(path.resolve(projectDir)) ?? null,
    write: (projectDir, entry) => {
      entries.set(path.resolve(projectDir), entry);
    },
  };
}

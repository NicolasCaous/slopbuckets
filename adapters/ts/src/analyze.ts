// `info` and `analyze` of ABI 2: analyze scans the requested files and resolves every import. See resolve.ts for the
// resolution rules.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { AdapterEnvironmentError } from './errors.js';
import { EXTENSIONS } from './paths.js';
import {
  ADAPTER_ABI,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type FileAnalysis,
  type ImportTarget,
  type InfoResponse,
  type PublicExports,
  type ResolutionInput,
} from './protocol.js';
import { emptyState, Resolver, type AdapterState, type ImportKind } from './resolve.js';
import { scan, type ScanResult } from './scan.js';

/** In-process extras of the CLI, outside the ABI. */
export interface AnalyzeOptions {
  /** The sorted project files, with `/`. Resolution then reads the list instead of the disk. */
  fileList?: readonly string[];
  /** State from an earlier run, updated in place. The CLI keeps it in its cache. */
  state?: AdapterState;
  /** The project-relative folders that hold a tsconfig.json, '' for the project folder. Without it, the disk tells. */
  tsconfigs?: readonly string[];
  /** Files the caller simulates as deleted though they are still on disk: they never count as files the listing skips. */
  deleted?: readonly string[];
  /** False when the project may lack a tsconfig.json, because no file of it needs one. Default true. */
  requireTsconfig?: boolean;
}

// The resolver of the last call per state object, reused while the file list is the same array.
const resolvers = new WeakMap<AdapterState, Resolver>();

function resolverFor(projectDir: string, options: AnalyzeOptions): Resolver {
  const state = options.state ?? emptyState();
  const files = options.fileList ?? null;
  const tsconfigs = options.tsconfigs ?? null;
  const known = resolvers.get(state);
  if (known !== undefined && known.projectDir === projectDir && known.files === files && known.tsconfigs === tsconfigs) {
    known.deleted = new Set(options.deleted ?? []);
    // The disk may have changed since the last call, as in a running buckets inspect.
    known.listings.clear();
    return known;
  }
  const resolver = new Resolver(projectDir, files, state, tsconfigs);
  resolver.deleted = new Set(options.deleted ?? []);
  resolvers.set(state, resolver);
  return resolver;
}

function errorResponse(error: unknown): AnalyzeResponse {
  if (error instanceof AdapterEnvironmentError) return { abi: ADAPTER_ABI, error: { code: error.code, message: error.message } };
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return { abi: ADAPTER_ABI, error: { code: 'adapter-failed', message: `adapter-ts failed: ${detail}` } };
}

/** The analysis of one file from its scan. */
export function toAnalysis(resolver: Resolver, file: string, scanned: ScanResult): FileAnalysis {
  const imports = scanned.imports.map((imp) => ({
    specifier: imp.specifier,
    line: imp.line,
    kind: imp.kind,
    literal: imp.literal,
    reexport: imp.reexport,
    names: imp.names,
    target: imp.literal ? resolver.resolve(file, imp.specifier, imp.kind) : ({ unresolved: 'other' } as ImportTarget),
  }));
  if (scanned.exports === undefined) return { imports };
  const exports: PublicExports = { names: scanned.exports.names, reexports: [], stars: [], codeLines: scanned.exports.codeLines };
  scanned.imports.forEach((imp, k) => {
    const target = imports[k]!.target;
    if (imp.exported !== undefined) exports.reexports.push({ line: imp.line, specifier: imp.specifier, target, names: imp.exported });
    else if (imp.starAs !== undefined) exports.stars.push({ line: imp.line, specifier: imp.specifier, target, as: imp.starAs });
  });
  return { imports, exports };
}

export function info(): InfoResponse {
  return { abi: ADAPTER_ABI, name: 'ts', version: pkg.version, extensions: [...EXTENSIONS] };
}

/** Scans the requested files and resolves their imports. Errors come back as `{ error }`, never thrown. */
export function analyze(projectDir: string, request: AnalyzeRequest, options: AnalyzeOptions = {}): AnalyzeResponse {
  try {
    if (request.abi !== ADAPTER_ABI) {
      throw new AdapterEnvironmentError('adapter-failed', `adapter-ts speaks protocol ${ADAPTER_ABI}, but the request uses protocol ${String(request.abi)}`);
    }
    const resolver = resolverFor(path.resolve(projectDir), options);
    if (request.files.length > 0 && options.requireTsconfig !== false) resolver.requireConfig();
    const publicFiles = new Set(request.publicFiles ?? []);
    const files: Record<string, FileAnalysis> = {};
    for (const file of request.files) {
      let text = request.contents?.[file];
      if (text === undefined) {
        try {
          text = readFileSync(path.join(projectDir, file), 'utf8');
        } catch {
          continue; // a file that cannot be read is left out
        }
      }
      files[file] = toAnalysis(resolver, file, scan(text, { exports: publicFiles.has(file) }));
    }
    return { abi: ADAPTER_ABI, files, inputs: resolver.state.inputs };
  } catch (error) {
    return errorResponse(error);
  }
}

export interface ResolveQuery {
  from: string;
  specifier: string;
  kind: ImportKind;
}

export type AdapterError = { code: 'no-typescript' | 'no-tsconfig' | 'adapter-failed'; message: string };

/** Resolves imports already scanned, without reading the files again. In-process extra, outside the ABI. */
export function resolveImports(
  projectDir: string,
  queries: readonly ResolveQuery[],
  options: AnalyzeOptions = {},
): { targets: ImportTarget[]; inputs: ResolutionInput[] } | { error: AdapterError } {
  try {
    const resolver = resolverFor(path.resolve(projectDir), options);
    if (queries.length > 0 && options.requireTsconfig !== false) resolver.requireConfig();
    return { targets: queries.map((q) => resolver.resolve(q.from, q.specifier, q.kind)), inputs: resolver.state.inputs };
  } catch (error) {
    const response = errorResponse(error);
    return { error: (response as { error: AdapterError }).error };
  }
}

// A fake adapter for unit tests. It reads the fixture files with regular expressions instead of the
// TypeScript compiler, which is enough for the one-statement-per-line code the tests write.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import {
  ABI_VERSION,
  type AnalyzeResponse,
  type DmzExport,
  type ImportEntry,
  type InfoResponse,
  type InitRequest,
  type InitResponse,
} from '@slopbuckets/adapter-ts';
import { sha256 } from '../core/hash.js';
import { parseJson } from '../core/json.js';
import { isPublishedFile, linkClosure } from '../core/links.js';
import type { Adapter, LinkAnalysis, LinkedAnalyzeRequest, LinkedAnalyzeResponse } from '../core/types.js';


export interface FakeAdapterOptions {
  info?: Partial<InfoResponse>;
  /** Problems returned in `analyze.config`. */
  projectConfig?: AnalyzeResponse['config'];
  /** Thrown by analyze instead of answering. */
  analyzeError?: unknown;
  initChanged?: InitResponse['changed'];
  /** Returned as `toolchain` by analyze. */
  toolchain?: string;
  /** Fills `unusedNames` for imported names that no other line of the file mentions. */
  reportUnused?: boolean;
  /** Leaves `typeOnly` out of import entries. */
  omitTypeOnly?: boolean;
  /** Leaves `links` out of the analyze answer, like an adapter written before source links. */
  omitLinks?: boolean;
  /** Problems reported for a link, by link path. */
  linkProblems?: Record<string, LinkAnalysis['problems']>;
  /** Leaves `inputs` out of analyze, like an adapter written before the cache keyed on them. */
  omitInputs?: boolean;
  /** More files to report in `inputs`, such as a tsconfig that tsconfig.json extends. */
  extraInputs?: string[];
}

export interface FakeAdapter extends Adapter {
  analyzeCalls: LinkedAnalyzeRequest[];
  initCalls: InitRequest[];
}

/**
 * True when `node_modules/<name>` exists in the folder of `fileAbs` or a folder above it, as Node looks it up. With
 * `real`, the lookup starts at the real location of the file (links followed), as Node does at runtime; without it,
 * at the path through the link, as the consumer's type checker does.
 */
function packageResolves(fileAbs: string, name: string, real = true): boolean {
  let dir: string;
  try {
    dir = path.dirname(real ? realpathSync.native(fileAbs) : path.resolve(fileAbs));
  } catch {
    dir = path.dirname(fileAbs);
  }
  for (;;) {
    if (existsSync(path.join(dir, 'node_modules', ...name.split('/')))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The signature hash of `name` as its declaring line in `fileAbs` reads, like the fake does for DMZ symbols. */
function declarationHash(fileAbs: string, name: string): string {
  if (!isFile(fileAbs)) return 'sha256:missing';
  const declaration = readFileSync(fileAbs, 'utf8')
    .split(/\r?\n/)
    .find((l) => new RegExp(`export\\s.*\\b${name}\\b`).test(l));
  return declaration ? sha256(declaration.trim()) : 'sha256:missing';
}

/** The fake description of one link: the published `.external` files, the packages the linked files import, and set problems. */
function analyzeLink(projectDir: string, link: { path: string; alias: string }, dmzExtension: string, problems: LinkAnalysis['problems']): LinkAnalysis {
  const linkAbs = path.join(projectDir, link.path);
  const exports: LinkAnalysis['exports'] = [];
  const dependencies: LinkAnalysis['dependencies'] = [];
  for (const rel of linkClosure(linkAbs, link.alias, dmzExtension)) {
    const abs = path.join(linkAbs, rel);
    readFileSync(abs, 'utf8')
      .split(/\r?\n/)
      .forEach((text, i) => {
        const spec = /(?:\bfrom|\bimport)\s*['"](.+?)['"]/.exec(text)?.[1];
        if (spec !== undefined && !spec.startsWith('.') && !spec.startsWith(`${link.alias}/`) && !spec.startsWith('node:') && !builtinModules.includes(spec)) {
          const name = packageName(spec);
          // Like the real adapter: types from the link path (the package or its @types package), runtime from the real path.
          const typesName = name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
          const resolvedForTypes = packageResolves(abs, name, false) || packageResolves(abs, typesName, false);
          const resolvedAtRuntime = /^\s*import\s+type\b/.test(text) || packageResolves(abs, name);
          dependencies.push({ package: name, from: `${link.path}/${rel}`, resolved: resolvedForTypes && resolvedAtRuntime, resolvedForTypes, resolvedAtRuntime });
        }
        if (!isPublishedFile(rel, dmzExtension)) return;
        const m = /^\s*export\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](.+?)['"]/.exec(text);
        if (!m) return;
        const target = m[3]!.startsWith(`${link.alias}/`) ? resolveInternal(projectDir, link.path, link.alias, m[3]!) : null;
        for (const part of m[2]!.split(',')) {
          const name = part.trim();
          if (name === '') continue;
          exports.push({
            file: `${link.path}/${rel}`,
            name,
            typeOnly: m[1] !== undefined,
            signature: target === null ? 'sha256:missing' : declarationHash(path.join(projectDir, target), name),
            line: i + 1,
          });
        }
      });
  }
  return { exports, dependencies, problems };
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

function resolveInternal(projectDir: string, root: string, alias: string, spec: string): string | null {
  const rest = spec.slice(alias.length + 1);
  const base = `${root}/${rest}`;
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), `${base}.d.ts`, ...EXTENSIONS.map((e) => `${base}/index${e}`), `${base}/index.d.ts`];
  for (const candidate of candidates) if (isFile(path.join(projectDir, candidate))) return candidate;
  return null;
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function declaredPackages(projectDir: string): Set<string> {
  try {
    const pkg = parseJson(readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/** `reexportedAs` of an `export ... from` clause: `{ a as b, c }`, `*` or `* as ns`. */
function parseReexports(clause: string): { name: string; as: string }[] {
  const text = clause.replace(/^type\s+/, '').trim();
  const star = /^\*(?:\s+as\s+(\w+))?$/.exec(text);
  if (star) return [{ name: '*', as: star[1] ?? '*' }];
  return text
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter((part) => part !== '')
    .map((part) => {
      const [name, as] = part.split(/\s+as\s+/);
      return { name: name!.trim(), as: (as ?? name!).trim() };
    });
}

function parseNames(clause: string): string[] {
  const text = clause.replace(/^type\s+/, '').trim();
  if (/^\*\s+as\s+\w+$/.test(text)) return ['*'];
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(text);
  const head = text.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
  if (head !== '') names.push('default');
  if (braces) {
    for (const part of braces[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name !== '') names.push(name);
    }
  }
  return names;
}

export function fakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const analyzeCalls: LinkedAnalyzeRequest[] = [];
  const initCalls: InitRequest[] = [];
  const info: InfoResponse = {
    abi: ABI_VERSION,
    name: 'ts',
    version: '1.0.0',
    extensions: EXTENSIONS,
    dmzExtension: '.ts',
    ...options.info,
  };

  return {
    analyzeCalls,
    initCalls,
    info: () => info,
    async init(_projectDir, request) {
      initCalls.push(request);
      return { abi: ABI_VERSION, changed: options.initChanged ?? [] };
    },
    async analyze(projectDir, request) {
      analyzeCalls.push(request);
      if (options.analyzeError !== undefined) throw options.analyzeError;
      const { root, alias } = request.config;
      const declared = declaredPackages(projectDir);

      const links = request.links ?? [];
      const classify = (spec: string, line: number, names: string[]): ImportEntry => {
        if (spec.startsWith('.')) return { kind: 'relative', target: spec, line };
        const link = links.find((l) => spec.startsWith(`${l.alias}/`));
        if (link !== undefined) {
          const target = resolveInternal(projectDir, link.path, link.alias, spec);
          return target === null ? { kind: 'unresolved', target: spec, line } : { kind: 'internal', target, names, line };
        }
        if (spec.startsWith(`${alias}/`)) {
          const target = resolveInternal(projectDir, root, alias, spec);
          return target === null ? { kind: 'unresolved', target: spec, line } : { kind: 'internal', target, names, line };
        }
        if (spec.startsWith('node:') || builtinModules.includes(spec)) return { kind: 'builtin', target: spec, line };
        const name = packageName(spec);
        return { kind: 'package', target: name, declared: declared.has(name), line };
      };

      const code: AnalyzeResponse['code'] = {};
      for (const file of request.files.code) {
        const imports: ImportEntry[] = [];
        const globals: { line: number; message: string }[] = [];
        const lines = readFileSync(path.join(projectDir, file), 'utf8').split(/\r?\n/);
        /** Names of an import statement that no other line of the file mentions. */
        const unusedIn = (names: string[], importLine: number): string[] =>
          names.filter((name) => name !== '*' && name !== 'default' && !lines.some((l, j) => j + 1 !== importLine && new RegExp(`\\b${name}\\b`).test(l)));
        lines.forEach((text, i) => {
          const line = i + 1;
          let m: RegExpExecArray | null;
          if ((m = /^\s*import\s+(.+?)\s+from\s+['"](.+?)['"]/.exec(text))) {
            const entry = classify(m[2]!, line, parseNames(m[1]!));
            if (!options.omitTypeOnly) entry.typeOnly = /^type\s/.test(m[1]!.trim());
            if (options.reportUnused && entry.names) {
              const unused = unusedIn(entry.names, line);
              if (unused.length > 0) entry.unusedNames = unused;
            }
            imports.push(entry);
          } else if ((m = /^\s*import\s+['"](.+?)['"]/.exec(text))) imports.push(classify(m[1]!, line, []));
          else if ((m = /^\s*export\s+(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"](.+?)['"]/.exec(text))) {
            imports.push({
              ...classify(m[2]!, line, parseNames(m[1]!)),
              reexport: true,
              reexportedAs: parseReexports(m[1]!),
              ...(options.omitTypeOnly ? {} : { typeOnly: /^\s*export\s+type\s/.test(text) }),
            });
          }
          const dynamic = /\b(?:import|require)\(\s*(?:['"](.+?)['"])?/.exec(text);
          if (dynamic && !/^\s*import\s/.test(text)) imports.push({ kind: 'dynamic', target: dynamic[1] ?? null, line });
          if (/^\s*declare\s+global\b/.test(text)) globals.push({ line, message: '`declare global` adds names to the global scope' });
          if (/^\s*\/\/\/\s*<reference\b/.test(text)) globals.push({ line, message: 'a /// <reference> directive pulls in another file without an import' });
        });
        code[file] = globals.length > 0 ? { imports, globals } : { imports };
      }

      const dmzSet = new Set(request.files.dmz);
      const parsed = new Map<string, { exports: Omit<DmzExport, 'signature'>[]; violations: { line: number; message: string }[] }>();
      for (const file of request.files.dmz) {
        const exports: Omit<DmzExport, 'signature'>[] = [];
        const violations: { line: number; message: string }[] = [];
        readFileSync(path.join(projectDir, file), 'utf8')
          .split(/\r?\n/)
          .forEach((text, i) => {
            const line = i + 1;
            if (text.trim() === '' || text.trim().startsWith('//')) return;
            const m = /^\s*export\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](.+?)['"];?\s*$/.exec(text);
            if (!m) {
              violations.push({ line, message: `only export { ... } from statements are allowed in a DMZ file` });
              return;
            }
            const spec = m[3]!;
            const from = spec.startsWith(`${alias}/`) ? (resolveInternal(projectDir, root, alias, spec) ?? spec) : spec;
            for (const part of m[2]!.split(',')) {
              const name = part.trim();
              if (name === '') continue;
              if (/\sas\s/.test(name)) {
                violations.push({ line, message: `renaming with "as" is not allowed in a DMZ file` });
                continue;
              }
              exports.push({ name, typeOnly: m[1] !== undefined, from, line });
            }
          });
        parsed.set(file, { exports, violations });
      }

      const signature = (from: string, name: string, depth = 0): string => {
        if (depth > 20) return 'sha256:cycle';
        if (dmzSet.has(from)) {
          const next = parsed.get(from)?.exports.find((e) => e.name === name);
          return next ? signature(next.from, name, depth + 1) : 'sha256:missing';
        }
        const abs = path.join(projectDir, from);
        if (!isFile(abs)) return 'sha256:missing';
        const declaration = readFileSync(abs, 'utf8')
          .split(/\r?\n/)
          .find((l) => new RegExp(`export\\s.*\\b${name}\\b`).test(l));
        return declaration ? sha256(declaration.trim()) : 'sha256:missing';
      };

      const dmz: AnalyzeResponse['dmz'] = {};
      for (const [file, entry] of parsed) {
        dmz[file] = {
          exports: entry.exports.map((e) => ({ ...e, signature: signature(e.from, e.name) })),
          violations: entry.violations,
        };
      }
      const response: LinkedAnalyzeResponse = { abi: ABI_VERSION, config: options.projectConfig ?? [], dmz, code };
      if (links.length > 0 && !options.omitLinks) {
        response.links = {};
        for (const link of links) response.links[link.path] = analyzeLink(projectDir, link, info.dmzExtension, options.linkProblems?.[link.path] ?? []);
      }
      if (options.toolchain !== undefined) response.toolchain = options.toolchain;
      // The files this fake read: every requested file, tsconfig.json and package.json.
      if (!options.omitInputs) response.inputs = [...new Set([...request.files.dmz, ...request.files.code, 'tsconfig.json', 'package.json', ...(options.extraInputs ?? [])])].sort();
      return response;
    },
  };
}

// The `compilerOptions.paths` entry that maps the alias of a linked project to its link folder, edited in place in
// the consumer's tsconfig.json, and the equivalent settings for the bundlers that `buckets link add` finds.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendItemEdits, JsoncText, removeItemEdits, removePropertyEdits, setPropertyEdits, UnsafeEdit, type JsonObject } from './jsonc.js';
import { toPosix } from './paths.js';

export const TSCONFIG = 'tsconfig.json';

export interface TsconfigEdit {
  /**
   * `added`, `updated` (the alias pointed elsewhere), `removed`, `unchanged` (already as wanted), `absent` (nothing to
   * remove), or `manual` when the file cannot be edited safely and `line` must be added or removed by hand.
   */
  status: 'added' | 'updated' | 'removed' | 'unchanged' | 'absent' | 'manual';
  /** The entry, as it reads inside `compilerOptions.paths`. */
  line: string;
  /** Why the file was not edited, for `manual`. */
  reason?: string;
}

/** The `paths` key of an alias. */
export function aliasPattern(alias: string): string {
  return `${alias}/*`;
}

/** The `paths` target of a link folder: relative to `baseUrl` when the file sets one, else to the tsconfig folder. */
export function linkTarget(projectDir: string, linkRel: string, baseUrl: string | undefined): string {
  const base = baseUrl === undefined ? projectDir : path.resolve(projectDir, baseUrl);
  const rel = toPosix(path.relative(base, path.join(projectDir, linkRel)));
  return `${rel.startsWith('../') || rel === '..' ? rel : `./${rel}`}/*`;
}

function entryLine(alias: string, target: string): string {
  return `"${aliasPattern(alias)}": ["${target}"]`;
}

interface Opened {
  doc: JsoncText;
  paths: JsonObject;
  target: string;
}

/** The tsconfig.json of the project with its `compilerOptions.paths` object, or why it cannot be edited. */
function open(projectDir: string, linkRel: string): Opened | { reason: string; target: string } {
  const file = path.join(projectDir, TSCONFIG);
  const fallback = linkTarget(projectDir, linkRel, undefined);
  if (!existsSync(file)) return { reason: `the project has no ${TSCONFIG}`, target: fallback };
  let doc: JsoncText;
  try {
    doc = new JsoncText(readFileSync(file, 'utf8'));
  } catch (error) {
    return { reason: error instanceof UnsafeEdit ? error.message : String(error), target: fallback };
  }
  const options = doc.property(doc.root, 'compilerOptions')?.value;
  const baseUrlNode = options?.kind === 'object' ? doc.property(options, 'baseUrl')?.value : undefined;
  const baseUrl = baseUrlNode?.kind === 'value' && typeof baseUrlNode.value === 'string' ? baseUrlNode.value : undefined;
  const target = linkTarget(projectDir, linkRel, baseUrl);
  const paths = options?.kind === 'object' ? doc.property(options, 'paths')?.value : undefined;
  if (paths?.kind !== 'object') {
    return {
      reason: `${TSCONFIG} has no "compilerOptions.paths" object of its own (the paths may come from "extends" or from a referenced config), and adding one here would hide the inherited entries`,
      target,
    };
  }
  return { doc, paths, target };
}

function sameTarget(value: unknown, target: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === target;
}

/** Adds (or points again) the paths entry of `alias` to the link folder `linkRel`, in place. */
export function addLinkPath(projectDir: string, alias: string, linkRel: string): TsconfigEdit {
  const opened = open(projectDir, linkRel);
  if ('reason' in opened) return { status: 'manual', line: entryLine(alias, opened.target), reason: opened.reason };
  const { doc, paths, target } = opened;
  const line = entryLine(alias, target);
  const existing = doc.property(paths, aliasPattern(alias));
  if (existing !== undefined && sameTarget(doc.valueOf(existing.value), target)) return { status: 'unchanged', line };
  try {
    const text = doc.apply(setPropertyEdits(doc, paths, aliasPattern(alias), [target]));
    writeFileSync(path.join(projectDir, TSCONFIG), text, 'utf8');
  } catch (error) {
    if (!(error instanceof UnsafeEdit)) throw error;
    return { status: 'manual', line, reason: `${error.message}, and editing it would lose them` };
  }
  return { status: existing === undefined ? 'added' : 'updated', line };
}

/** Removes the paths entry of `alias` when it still points at the link folder `linkRel`. */
export function removeLinkPath(projectDir: string, alias: string, linkRel: string): TsconfigEdit {
  const opened = open(projectDir, linkRel);
  if ('reason' in opened) return { status: 'manual', line: entryLine(alias, opened.target), reason: opened.reason };
  const { doc, paths, target } = opened;
  const line = entryLine(alias, target);
  const existing = doc.property(paths, aliasPattern(alias));
  if (existing === undefined || !sameTarget(doc.valueOf(existing.value), target)) return { status: 'absent', line };
  try {
    const text = doc.apply(removePropertyEdits(doc, paths, aliasPattern(alias)));
    writeFileSync(path.join(projectDir, TSCONFIG), text, 'utf8');
  } catch (error) {
    if (!(error instanceof UnsafeEdit)) throw error;
    return { status: 'manual', line, reason: `${error.message}, and editing it would lose them` };
  }
  return { status: 'removed', line };
}

// ---- exclude ----
//
// A link folder holds the whole root folder of another project (or a copy of part of it). The consumer's tsconfig
// includes its own root folder, so without an `exclude` entry `tsc` here would compile every file of the origin with
// this project's settings and alias, and follow the origin's own links (back into this project, for two projects
// that link each other). `exclude` does not apply to files that an included file imports, so the linked files that
// code imports still compile.

export interface ExcludeEdit {
  /** `added`, `removed`, `unchanged` (already excluded), `absent` (nothing to remove), or `manual` (see `line`). */
  status: 'added' | 'removed' | 'unchanged' | 'absent' | 'manual';
  /** The `exclude` entry of the link folder, quoted, or the whole `"exclude": [...]` property when the edit adds one. */
  line: string;
  /** Why the file was not edited, for `manual`. */
  reason?: string;
}

/** An `exclude` entry without `./` in front and without a trailing `/`, `/**` or `/**\/*`, for comparisons. */
function excludeKey(spec: string): string {
  return spec.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/(?:\*\*(?:\/\*)?)?$/, '');
}

function readJsonc(file: string): JsoncText | null {
  try {
    return new JsoncText(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isFileAt(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The file that an `extends` value names, as TypeScript finds it: a path relative to the config folder (with `.json`
 * added when needed), or a package config found in node_modules folders from the config folder up. Null when not found.
 */
function resolveExtends(configDir: string, spec: string): string | null {
  const posix = spec.replace(/\\/g, '/');
  if (posix.startsWith('./') || posix.startsWith('../') || path.isAbsolute(spec)) {
    const file = path.resolve(configDir, spec);
    if (isFileAt(file)) return file;
    return !file.endsWith('.json') && isFileAt(`${file}.json`) ? `${file}.json` : null;
  }
  for (let dir = configDir; ; dir = path.dirname(dir)) {
    const base = path.join(dir, 'node_modules', ...posix.split('/'));
    for (const candidate of [base, `${base}.json`, path.join(base, TSCONFIG)]) if (isFileAt(candidate)) return candidate;
    const manifest = readJsonc(path.join(base, 'package.json'));
    const field = manifest === null ? undefined : manifest.property(manifest.root, 'tsconfig')?.value;
    if (field?.kind === 'value' && typeof field.value === 'string' && isFileAt(path.join(base, field.value))) return path.join(base, field.value);
    if (path.dirname(dir) === dir) return null;
  }
}

type Inherited = { exclude?: string[]; outDirs: Partial<Record<'outDir' | 'declarationDir', string>> };

/**
 * What a config has after `extends`: the `exclude` patterns, absolute (a `${configDir}` pattern stays as written), and
 * `outDir` and `declarationDir`, absolute. A later config in `extends` overrides an earlier one, and the file itself
 * overrides them all, as in TypeScript. Throws an Error naming the config that cannot be read.
 */
function effectiveSettings(file: string, doc: JsoncText, seen: Set<string>): Inherited {
  const dir = path.dirname(file);
  const out: Inherited = { outDirs: {} };
  const extendsNode = doc.property(doc.root, 'extends')?.value;
  const extendsValue = extendsNode === undefined ? [] : doc.valueOf(extendsNode);
  for (const spec of Array.isArray(extendsValue) ? extendsValue : [extendsValue]) {
    if (typeof spec !== 'string') continue;
    const base = resolveExtends(dir, spec);
    if (base === null) throw new Error(`the config "${spec}" that ${path.basename(file)} extends was not found`);
    if (seen.has(base)) continue;
    const baseDoc = readJsonc(base);
    if (baseDoc === null) throw new Error(`the config ${toPosix(base)} that ${path.basename(file)} extends cannot be read`);
    const inherited = effectiveSettings(base, baseDoc, new Set([...seen, base]));
    if (inherited.exclude !== undefined) out.exclude = inherited.exclude;
    Object.assign(out.outDirs, inherited.outDirs);
  }
  const own = doc.property(doc.root, 'exclude')?.value;
  if (own !== undefined) {
    const value = doc.valueOf(own);
    out.exclude = (Array.isArray(value) ? value : []).filter((s): s is string => typeof s === 'string').map((s) => (s.startsWith('${configDir}') ? s : path.resolve(dir, s)));
  }
  const options = doc.property(doc.root, 'compilerOptions')?.value;
  for (const key of ['outDir', 'declarationDir'] as const) {
    const node = options?.kind === 'object' ? doc.property(options, key)?.value : undefined;
    if (node?.kind === 'value' && typeof node.value === 'string') out.outDirs[key] = path.resolve(dir, node.value);
  }
  return out;
}

/**
 * The `exclude` patterns that tsconfig.json at `file` gets without an `exclude` of its own, written relative to its
 * folder: the patterns inherited through `extends`, or, when no config declares any, `outDir` and `declarationDir`,
 * which TypeScript then excludes by default. A declared `exclude` replaces all of these, so a new one copies them.
 */
export function inheritedExclude(file: string, doc: JsoncText): string[] {
  const dir = path.dirname(file);
  const own = doc.property(doc.root, 'exclude');
  // Read without the file's own `exclude`, as if it had none.
  const settings = effectiveSettings(file, own === undefined ? doc : new JsoncText(doc.apply(removePropertyEdits(doc, doc.root as JsonObject, 'exclude'))), new Set([file]));
  const specs = settings.exclude ?? [settings.outDirs.outDir, settings.outDirs.declarationDir].filter((d): d is string => d !== undefined);
  return specs.map((spec) => (spec.startsWith('${configDir}') ? spec : toPosix(path.relative(dir, spec)) || '.'));
}

interface OpenedConfig {
  file: string;
  doc: JsoncText;
  root: JsonObject;
}

function openConfig(projectDir: string): OpenedConfig | { reason: string } {
  const file = path.join(projectDir, TSCONFIG);
  if (!existsSync(file)) return { reason: `the project has no ${TSCONFIG}` };
  let doc: JsoncText;
  try {
    doc = new JsoncText(readFileSync(file, 'utf8'));
  } catch (error) {
    return { reason: error instanceof UnsafeEdit ? error.message : String(error) };
  }
  if (doc.root.kind !== 'object') return { reason: `${TSCONFIG} is not a JSON object` };
  return { file, doc, root: doc.root };
}

/**
 * Adds the link folder `linkRel` to `exclude` of the project's tsconfig.json, in place. A file without an `exclude`
 * of its own gets one that starts with the inherited patterns (see `inheritedExclude`).
 */
export function addLinkExclude(projectDir: string, linkRel: string): ExcludeEdit {
  const entry = linkRel;
  const quoted = JSON.stringify(entry);
  const opened = openConfig(projectDir);
  if ('reason' in opened) return { status: 'manual', line: quoted, reason: opened.reason };
  const { file, doc, root } = opened;
  const own = doc.property(root, 'exclude');
  if (own !== undefined) {
    if (own.value.kind !== 'array') return { status: 'manual', line: quoted, reason: `"exclude" in ${TSCONFIG} is not an array` };
    const items = doc.valueOf(own.value) as unknown[];
    if (items.some((item) => typeof item === 'string' && excludeKey(item) === entry)) return { status: 'unchanged', line: quoted };
    try {
      writeFileSync(file, doc.apply(appendItemEdits(doc, own.value, entry)), 'utf8');
    } catch (error) {
      if (!(error instanceof UnsafeEdit)) throw error;
      return { status: 'manual', line: quoted, reason: `${error.message}, and editing it would lose them` };
    }
    return { status: 'added', line: quoted };
  }
  let inherited: string[];
  try {
    inherited = inheritedExclude(file, doc);
  } catch (error) {
    return {
      status: 'manual',
      line: `"exclude": [${quoted}]`,
      reason: `${error instanceof Error ? error.message : String(error)}, so the "exclude" patterns it inherits are unknown (a new "exclude" replaces them, so copy them into it too)`,
    };
  }
  const fresh = [...inherited.filter((spec) => excludeKey(spec) !== entry), entry];
  const line = `"exclude": ${JSON.stringify(fresh).replace(/","/g, '", "')}`;
  try {
    writeFileSync(file, doc.apply(setPropertyEdits(doc, root, 'exclude', fresh)), 'utf8');
  } catch (error) {
    if (!(error instanceof UnsafeEdit)) throw error;
    return { status: 'manual', line, reason: `${error.message}, and editing it would lose them` };
  }
  return { status: 'added', line };
}

/** Removes the link folder `linkRel` from `exclude` of the project's tsconfig.json, in place. */
export function removeLinkExclude(projectDir: string, linkRel: string): ExcludeEdit {
  const quoted = JSON.stringify(linkRel);
  const opened = openConfig(projectDir);
  if ('reason' in opened) return { status: 'manual', line: quoted, reason: opened.reason };
  const { file, doc, root } = opened;
  const own = doc.property(root, 'exclude')?.value;
  if (own?.kind !== 'array') return { status: 'absent', line: quoted };
  const index = own.items.findIndex((item) => item.kind === 'value' && typeof item.value === 'string' && excludeKey(item.value) === linkRel);
  if (index === -1) return { status: 'absent', line: quoted };
  try {
    // An `exclude` that held only this entry goes away with it, as `addLinkExclude` found the file: it copies the
    // inherited patterns into a new `exclude`, so a one-entry `exclude` means there were none.
    const edits = own.items.length === 1 ? removePropertyEdits(doc, root, 'exclude') : removeItemEdits(doc, own, index);
    writeFileSync(file, doc.apply(edits), 'utf8');
  } catch (error) {
    if (!(error instanceof UnsafeEdit)) throw error;
    return { status: 'manual', line: quoted, reason: `${error.message}, and editing it would lose them` };
  }
  return { status: 'removed', line: quoted };
}

const BUNDLERS: { name: 'Vite' | 'Next.js' | 'webpack'; files: string[] }[] = [
  { name: 'Vite', files: ['vite.config.ts', 'vite.config.mts', 'vite.config.cts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'] },
  { name: 'Next.js', files: ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'] },
  { name: 'webpack', files: ['webpack.config.ts', 'webpack.config.js', 'webpack.config.mjs', 'webpack.config.cjs'] },
];

/**
 * What to add to each bundler config found in the project folder so the bundler resolves the alias of a linked
 * project like TypeScript does. The CLI only prints this; it never edits a bundler config.
 */
export function bundlerInstructions(projectDir: string, alias: string, linkRel: string): string[] {
  const out: string[] = [];
  const rel = `./${linkRel}`;
  for (const bundler of BUNDLERS) {
    const file = bundler.files.find((f) => existsSync(path.join(projectDir, f)));
    if (file === undefined) continue;
    if (bundler.name === 'Vite') {
      out.push(
        `${file} (Vite): add the alias to "resolve.alias", with \`import { fileURLToPath } from 'node:url'\` at the top:\n` +
          `  resolve: { alias: { '${alias}': fileURLToPath(new URL('${rel}', import.meta.url)) } }`,
      );
    } else if (bundler.name === 'Next.js') {
      out.push(
        `${file} (Next.js): next dev and next build read "compilerOptions.paths" from ${TSCONFIG}, so the ${TSCONFIG} entry is enough. A custom webpack function in ${file} needs the alias too:\n` +
          `  webpack: (config) => { config.resolve.alias['${alias}'] = path.resolve(__dirname, '${rel}'); return config; }`,
      );
    } else {
      out.push(`${file} (webpack): add the alias to "resolve.alias":\n  resolve: { alias: { '${alias}': path.resolve(__dirname, '${rel}') } }`);
    }
  }
  return out;
}

// Reads buckets.config.json v2 and reports every problem as a ConfigProblem (config-invalid), following
// site/schema/v2.json. A valid config becomes a Config with normalized paths.
import { createHash } from 'node:crypto';
import {
  BUCKET_KEYS,
  BUCKET_NAME_PATTERN,
  BUCKET_REQUIRED_KEYS,
  CONFIG_KEYS,
  configVersionStatus,
  packageKey,
  publicFiles,
  type ConfigPath,
  type ConfigProblem,
} from '../contract/index.js';
import { isRecord, parseJson } from '../files/index.js';
import { compileGlob, GlobError } from './owners.js';

export interface Bucket {
  name: string;
  purpose: string;
  /** Globs as written, `!` included. */
  files: string[];
  /** Normalized project-relative paths in the order written, [] for a closed bucket. */
  public: string[];
  dependsOn: Record<string, string>;
  /** Packages key to reason. */
  packages: Record<string, string>;
  external: string | null;
}

export interface Config {
  /** sha1 of the text. */
  hash: string;
  /** Globs as written. */
  ignore: string[];
  /** Nested project folders as written, and normalized. */
  projects: { written: string; folder: string }[];
  /** In the order of the file. */
  buckets: Bucket[];
}

/**
 * `newer`: the version field names a format this CLI does not read (configVersionStatus), so nothing else was
 * validated and the engine reports config-newer.
 */
export type ConfigResult = { config: Config } | { problems: ConfigProblem[]; projects: { written: string; folder: string }[] } | { newer: string };

/**
 * A content hash for cache keys. node:crypto loads in under 1 ms and hashes the 225 KB config of 500 buckets in
 * 0.2 ms, where a hash loop in JavaScript took 2 to 3 ms before the JIT warmed up.
 */
export function configHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** `./src/a.ts`, `src\a.ts` and `src//a.ts` become `src/a.ts`. Returns null for a path that leaves the folder. */
export function normalizePath(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A glob without a leading `./`, with `/` separators, keeping a leading `!`. */
export function normalizeGlob(glob: string): string {
  const neg = glob.startsWith('!');
  let g = (neg ? glob.slice(1) : glob).replace(/\\/g, '/');
  while (g.startsWith('./')) g = g.slice(2);
  return (neg ? '!' : '') + g;
}

const NO_GLOB = /[*?[\]{}!]/;
/** The `line` pattern of the schema: one line with something other than spaces. */
const ONE_LINE = /^[^\r\n]*\S[^\r\n]*$/;

/** The shape of a config that passed validateConfig. */
interface ValidConfig {
  ignore?: string[];
  projects?: string[];
  buckets: Record<string, { purpose: string; files: string[]; public: string | string[] | null; dependsOn: Record<string, string>; packages: Record<string, string>; external?: string }>;
}

/**
 * Reads a config. `trusted` is the hash of a text this function already accepted: that text skips the checks, which
 * cost about 10 ms for a config with 18,000 reasons. Both ways build the Config with toConfig.
 */
export function parseConfig(text: string, trusted?: string): ConfigResult {
  if (trusted !== undefined && configHash(text) === trusted) return { config: toConfig(parseJson(text) as ValidConfig, trusted) };
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch (error) {
    return { problems: [{ kind: 'json', message: (error as Error).message }], projects: [] };
  }
  if (!isRecord(raw)) return { problems: [{ kind: 'invalid', at: [], expected: 'an object' }], projects: [] };
  const checked = validateConfig(raw);
  if ('newer' in checked) return checked;
  if (checked.problems.length > 0) return checked;
  return { config: toConfig(raw as unknown as ValidConfig, configHash(text)) };
}

/** The Config of a config that passed validateConfig. */
function toConfig(raw: ValidConfig, hash: string): Config {
  return {
    hash,
    ignore: raw.ignore ?? [],
    projects: (raw.projects ?? []).map((written) => ({ written, folder: normalizePath(written) ?? '' })),
    buckets: Object.entries(raw.buckets).map(([name, b]) => ({
      name,
      purpose: b.purpose,
      files: b.files,
      public: publicFiles(b.public).map((f) => normalizePath(f) ?? ''),
      dependsOn: b.dependsOn,
      packages: b.packages,
      external: b.external ?? null,
    })),
  };
}

/** The checks of one config, which push what they find into `problems`. */
function checker(problems: ConfigProblem[]) {
  const line = (value: unknown, at: ConfigPath): void => {
    if (typeof value !== 'string') problems.push({ kind: 'invalid', at, expected: 'a string' });
    else if (/[\r\n]/.test(value)) problems.push({ kind: 'multiline', at });
    else if (value.trim() === '') problems.push({ kind: 'empty', at });
  };
  /** A reason of dependsOn or packages. The common case first: a config can hold tens of thousands of them. */
  const reason = (value: unknown, at: ConfigPath): void => {
    if (!(typeof value === 'string' && ONE_LINE.test(value))) line(value, at);
  };
  const stringList = (value: unknown, at: ConfigPath, check?: (item: string, at: ConfigPath) => boolean): void => {
    if (!Array.isArray(value)) {
      problems.push({ kind: 'invalid', at, expected: 'an array of strings' });
      return;
    }
    value.forEach((item, i) => {
      const itemAt = [...at, i];
      if (typeof item !== 'string') problems.push({ kind: 'invalid', at: itemAt, expected: 'a string' });
      else if (item === '') problems.push({ kind: 'empty', at: itemAt });
      else if (/[\r\n]/.test(item)) problems.push({ kind: 'multiline', at: itemAt });
      else check?.(item, itemAt);
    });
  };
  // Every glob compiles here, so the owners never meet one that throws.
  const validGlob = (item: string, at: ConfigPath): boolean => {
    try {
      compileGlob(normalizeGlob(item).replace(/^!/, ''));
      return true;
    } catch (error) {
      if (!(error instanceof GlobError)) throw error;
      problems.push({ kind: 'invalid', at, expected: error.expected });
      return false;
    }
  };
  return { problems, line, reason, stringList, validGlob };
}

type Checker = ReturnType<typeof checker>;

/** Every problem of a parsed config, and its valid nested projects, or `newer` for a format this CLI does not read. */
function validateConfig(raw: Record<string, unknown>): { problems: ConfigProblem[]; projects: Config['projects'] } | { newer: string } {
  const c = checker([]);
  const { problems } = c;
  // The version comes first: a newer format may hold fields this CLI does not know.
  if (raw.version === undefined) problems.push({ kind: 'missing', at: [], field: 'version' });
  else {
    const status = configVersionStatus(raw.version);
    if (status === 'newer') return { newer: raw.version as string };
    if (status === 'invalid') problems.push({ kind: 'invalid', at: ['version'], expected: 'a version string such as "2.0"' });
  }
  for (const key of Object.keys(raw)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) problems.push({ kind: 'unknown-field', at: [], field: key });
  }
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') problems.push({ kind: 'invalid', at: ['$schema'], expected: 'a string' });
  if (raw.ignore !== undefined) c.stringList(raw.ignore, ['ignore'], c.validGlob);
  const projects = raw.projects === undefined ? [] : validateProjects(c, raw.projects);
  if (raw.buckets === undefined) problems.push({ kind: 'missing', at: [], field: 'buckets' });
  else if (!isRecord(raw.buckets)) problems.push({ kind: 'invalid', at: ['buckets'], expected: 'an object' });
  else {
    const names = new Set(Object.keys(raw.buckets));
    for (const [name, value] of Object.entries(raw.buckets)) validateBucket(c, name, value, names);
  }
  return { problems, projects };
}

/** The nested projects, or none when one of them has a problem. */
function validateProjects(c: Checker, value: unknown): Config['projects'] {
  const before = c.problems.length;
  const projects: Config['projects'] = [];
  c.stringList(value, ['projects'], (item, at) => {
    if (NO_GLOB.test(item)) {
      c.problems.push({ kind: 'invalid', at, expected: 'a folder path without glob characters' });
      return false;
    }
    const folder = normalizePath(item);
    if (folder === null || folder === '') {
      c.problems.push({ kind: 'invalid', at, expected: 'a folder inside this project' });
      return false;
    }
    projects.push({ written: item, folder });
    return true;
  });
  return c.problems.length > before ? [] : projects;
}

function validateBucket(c: Checker, name: string, value: unknown, names: Set<string>): void {
  const { problems } = c;
  if (!BUCKET_NAME_PATTERN.test(name)) problems.push({ kind: 'bucket-name', name });
  const at: ConfigPath = ['buckets', name];
  if (!isRecord(value)) {
    problems.push({ kind: 'invalid', at, expected: 'an object' });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(BUCKET_KEYS as readonly string[]).includes(key)) problems.push({ kind: 'unknown-field', at, field: key });
  }
  for (const key of BUCKET_REQUIRED_KEYS) if (!(key in value)) problems.push({ kind: 'missing', at, field: key });
  if ('purpose' in value) c.line(value.purpose, [...at, 'purpose']);
  if ('files' in value) {
    if (Array.isArray(value.files) && value.files.length === 0) problems.push({ kind: 'empty', at: [...at, 'files'] });
    else c.stringList(value.files, [...at, 'files'], c.validGlob);
  }
  if ('public' in value && value.public !== null) validatePublic(c, value.public, [...at, 'public']);
  if ('dependsOn' in value) {
    if (!isRecord(value.dependsOn)) problems.push({ kind: 'invalid', at: [...at, 'dependsOn'], expected: 'an object' });
    else {
      for (const [dep, reason] of Object.entries(value.dependsOn)) {
        if (!names.has(dep)) problems.push({ kind: 'unknown-bucket', bucket: name, dependency: dep });
        c.reason(reason, [...at, 'dependsOn', dep]);
      }
    }
  }
  if ('packages' in value) {
    if (!isRecord(value.packages)) problems.push({ kind: 'invalid', at: [...at, 'packages'], expected: 'an object' });
    else {
      for (const [pkg, reason] of Object.entries(value.packages)) {
        const key = packageKey(pkg);
        if (key !== pkg) problems.push({ kind: 'package-name', bucket: name, name: pkg, key });
        c.reason(reason, [...at, 'packages', pkg]);
      }
    }
  }
  if ('external' in value) c.line(value.external, [...at, 'external']);
}

/** `public`: one path, or a non-empty list of distinct paths, each inside this project and without glob characters. */
function validatePublic(c: Checker, value: unknown, at: ConfigPath): void {
  const { problems } = c;
  const seen: string[] = [];
  const onePath = (item: unknown, itemAt: ConfigPath): void => {
    if (typeof item !== 'string') problems.push({ kind: 'invalid', at: itemAt, expected: 'a string' });
    else if (item === '') problems.push({ kind: 'empty', at: itemAt });
    else if (/[\r\n]/.test(item)) problems.push({ kind: 'multiline', at: itemAt });
    else if (NO_GLOB.test(item)) problems.push({ kind: 'invalid', at: itemAt, expected: 'a file path without glob characters' });
    else {
      const file = normalizePath(item);
      if (file === null || file === '') problems.push({ kind: 'invalid', at: itemAt, expected: 'a file path inside this project' });
      else if (seen.includes(file)) problems.push({ kind: 'invalid', at: itemAt, expected: 'a file path that the list does not already hold' });
      else seen.push(file);
    }
  };
  if (typeof value === 'string') onePath(value, at);
  else if (!Array.isArray(value)) problems.push({ kind: 'invalid', at, expected: 'a file path, a non-empty array of file paths, or null' });
  else if (value.length === 0) problems.push({ kind: 'empty', at });
  else value.forEach((item, i) => onePath(item, [...at, i]));
}

/** The bucket keys of a config text in file order, or [] when it is not a JSON object with a buckets object. */
function bucketKeys(text: string): string[] {
  try {
    const raw = parseJson(text);
    return isRecord(raw) && isRecord(raw.buckets) ? Object.keys(raw.buckets) : [];
  } catch {
    return [];
  }
}

/**
 * The problems of an edited config, with the unknown-bucket problems of a renamed key replaced: when the edit removes a
 * bucket key that a dependsOn still names and adds a key, those problems become one bucket-renamed to the first added
 * key in file order. `before` is the config on disk.
 */
export function withRenames(problems: ConfigProblem[], before: string | null, after: string): ConfigProblem[] {
  if (before === null || !problems.some((p) => p.kind === 'unknown-bucket')) return problems;
  const old = new Set(bucketKeys(before));
  const now = bucketKeys(after);
  const added = now.filter((k) => !old.has(k));
  if (added.length === 0) return problems;
  const kept = new Set(now);
  const out: ConfigProblem[] = [];
  const renamed = new Map<string, Extract<ConfigProblem, { kind: 'bucket-renamed' }>>();
  for (const p of problems) {
    if (p.kind !== 'unknown-bucket' || !old.has(p.dependency) || kept.has(p.dependency)) {
      out.push(p);
      continue;
    }
    let r = renamed.get(p.dependency);
    if (r === undefined) {
      renamed.set(p.dependency, (r = { kind: 'bucket-renamed', from: p.dependency, to: added[0]!, referencedBy: [] }));
      out.push(r);
    }
    if (!r.referencedBy.includes(p.bucket)) r.referencedBy.push(p.bucket);
  }
  for (const r of renamed.values()) r.referencedBy.sort();
  return out;
}

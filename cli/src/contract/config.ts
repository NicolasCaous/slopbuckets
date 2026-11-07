// Types of buckets.config.json version 2. site/schema/v2.json is the source of truth, and contract.test.ts checks
// that the key lists below match it.
import { builtinModules } from 'node:module';
import { CONFIG_VERSION } from './rules.js';

export { CONFIG_VERSION };

export const SCHEMA_URL = 'https://nicolascaous.github.io/slopbuckets/schema/v2.json';

/** `<major>.<minor>`, both plain numbers. */
export const CONFIG_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Lowercase letters, digits and `-`, starting with a letter. */
export const BUCKET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface BucketsConfigV2 {
  $schema?: string;
  /**
   * The config format version, `"2.0"` for this release. Read before anything else: a version this CLI does not read
   * stops the check with the environment error config-newer, and the rest of the file is not validated.
   */
  version: string;
  /**
   * Globs of files outside the architecture. The check removes these files before it matches any bucket glob, so a
   * file here is ignored even when a bucket's `files` matches it. A leading `!` takes files back out of ignore. Default `[]`.
   */
  ignore?: string[];
  /** Folders of nested projects, relative to this config, each with its own buckets.config.json. Default `[]`. */
  projects?: string[];
  buckets: Record<string, BucketDef>;
}

export interface BucketDef {
  /** One non-empty line. */
  purpose: string;
  /** Non-empty list of globs relative to the config. A leading `!` excludes files. */
  files: string[];
  /**
   * The files other buckets may import: one path, a non-empty list of paths, or null when the bucket exports
   * nothing. Each file holds only named re-exports of files of its own bucket. publicFiles() reads every form.
   */
  public: string | string[] | null;
  /** Bucket name to a non-empty one-line reason. `{}` when the bucket depends on nothing. */
  dependsOn: Record<string, string>;
  /**
   * Every external module the files of the bucket import, npm packages and Node built-ins, to a non-empty one-line
   * reason. `{}` when the bucket imports none. Keys are package names (`lodash`, `@scope/pkg`, never a subpath) and
   * built-ins as `node:fs`; packageKey() turns a specifier into its key. Type-only imports count.
   */
  packages: Record<string, string>;
  /** One-line reason why code outside the project uses the public files. Exempts the bucket from export-unused. */
  external?: string;
}

export const CONFIG_KEYS = ['$schema', 'version', 'ignore', 'projects', 'buckets'] as const satisfies readonly (keyof BucketsConfigV2)[];
export const CONFIG_REQUIRED_KEYS = ['version', 'buckets'] as const satisfies readonly (keyof BucketsConfigV2)[];
export const BUCKET_KEYS = ['purpose', 'files', 'public', 'dependsOn', 'packages', 'external'] as const satisfies readonly (keyof BucketDef)[];
export const BUCKET_REQUIRED_KEYS = ['purpose', 'files', 'public', 'dependsOn', 'packages'] as const satisfies readonly (keyof BucketDef)[];

/** The public files of a bucket in the order written: [] for null, one entry for a string. */
export function publicFiles(value: string | readonly string[] | null): string[] {
  return value === null ? [] : typeof value === 'string' ? [value] : [...value];
}

/**
 * How this CLI treats a `version` value. `supported`: the major is 2 and the minor is at most the minor of
 * CONFIG_VERSION. `newer`: a greater major, or major 2 with a greater minor; the engine reports config-newer and stops.
 * `invalid`: not a `<major>.<minor>` string, or a major below 2; that is config-invalid at ["version"].
 */
export function configVersionStatus(version: unknown): 'supported' | 'newer' | 'invalid' {
  const m = typeof version === 'string' ? CONFIG_VERSION_PATTERN.exec(version) : null;
  if (m === null) return 'invalid';
  const [major, minor] = CONFIG_VERSION.split('.').map(Number) as [number, number];
  const [vMajor, vMinor] = [Number(m[1]), Number(m[2])];
  if (vMajor < major) return 'invalid';
  return vMajor > major || vMinor > minor ? 'newer' : 'supported';
}

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));

/**
 * The `packages` key of an external import specifier: the package name for an npm package (`lodash/merge` is
 * `lodash`, `@scope/pkg/x` is `@scope/pkg`), and `node:<name>` for a Node built-in (`fs` and `fs/promises` are
 * `node:fs`). A config key is valid when packageKey(key) === key.
 */
export function packageKey(specifier: string): string {
  if (specifier.startsWith('node:')) return `node:${specifier.slice(5).split('/')[0]}`;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return BUILTINS.has(parts[0]!) ? `node:${parts[0]}` : name;
}

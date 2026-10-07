// Loading and validation of buckets.config.json. The rules mirror site/schema/v1.json, checked by hand
// so the CLI has no runtime dependency.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAccessLine, type AccessConfig } from './access-glob.js';
import { canonicalJson, sha256 } from './hash.js';
import { parseJson } from './json.js';
import { CONFIG_FILE, toPosix } from './paths.js';
import type { Violation } from './types.js';

export const SCHEMA_URL = 'https://nicolascaous.github.io/slopbuckets/schema/v1.json';

export interface ResolvedConfig {
  adapter: string;
  root: string;
  alias: string;
  maxDepth: number;
  /** Absent when the config has no `access` key, so the hash of a config without it stays the same. */
  access?: AccessConfig;
}

export const DEFAULT_CONFIG: ResolvedConfig = { adapter: 'ts', root: 'root', alias: '@root', maxDepth: 2 };

const ADAPTERS = ['ts'];
const KNOWN_KEYS = new Set(['$schema', 'adapter', 'root', 'alias', 'maxDepth', 'access']);
const ACCESS_KEYS = new Set(['default', 'allow', 'deny']);

export type ConfigResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; violations: Violation[] }
  | { kind: 'ok'; config: ResolvedConfig };

function invalid(message: string): Violation {
  return { rule: 'config-invalid', file: CONFIG_FILE, message };
}

/** Validates the parsed config and fills in the defaults. Returns the violations when the value breaks the schema. */
export function validateConfig(raw: unknown): { config?: ResolvedConfig; violations: Violation[] } {
  const violations: Violation[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { violations: [invalid(`${CONFIG_FILE} must contain a JSON object. Write an object such as {"root": "root"}.`)] };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      violations.push(invalid(`Unknown field "${key}" in ${CONFIG_FILE}. Remove it. The allowed fields are adapter, root, alias, maxDepth and access.`));
    }
  }
  const config: ResolvedConfig = { ...DEFAULT_CONFIG };

  if ('$schema' in obj && typeof obj.$schema !== 'string') {
    violations.push(invalid(`Field "$schema" must be a string. Set it to "${SCHEMA_URL}".`));
  }

  if ('adapter' in obj) {
    if (typeof obj.adapter !== 'string' || !ADAPTERS.includes(obj.adapter)) {
      violations.push(invalid(`Field "adapter" must be one of ${ADAPTERS.map((a) => `"${a}"`).join(', ')}. Set it to "ts" or remove it.`));
    } else {
      config.adapter = obj.adapter;
    }
  }

  if ('root' in obj) {
    const root = obj.root;
    if (typeof root !== 'string' || root.length === 0) {
      violations.push(invalid('Field "root" must be a non-empty string with the root bucket folder, relative to the project. Set it to "root" or remove it.'));
    } else {
      const normalized = toPosix(root);
      const segments = normalized.split('/');
      if (path.isAbsolute(root) || /^[a-zA-Z]:/.test(root) || normalized.startsWith('/')) {
        violations.push(invalid(`Field "root" is the absolute path "${root}". Use a folder relative to the project, such as "root".`));
      } else if (segments.some((s) => s === '..' || s === '.' || s === '')) {
        violations.push(invalid(`Field "root" is "${root}", which leaves the project folder or names the project itself. Use a subfolder such as "root".`));
      } else {
        config.root = normalized;
      }
    }
  }

  if ('alias' in obj) {
    if (typeof obj.alias !== 'string' || obj.alias.length === 0) {
      violations.push(invalid('Field "alias" must be a non-empty string with the import prefix. Set it to "@root" or remove it.'));
    } else {
      config.alias = obj.alias;
    }
  }

  if ('maxDepth' in obj) {
    const depth = obj.maxDepth;
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1) {
      violations.push(invalid('Field "maxDepth" must be an integer of at least 1. Set it to 2 or remove it.'));
    } else {
      config.maxDepth = depth;
    }
  }

  if ('access' in obj) {
    const access = validateAccess(obj.access, config.root, violations);
    if (access) config.access = access;
  }

  return violations.length > 0 ? { violations } : { config, violations };
}

/**
 * What is wrong with a side of an access line that starts with neither the root path nor `**`, or null. Every bucket
 * path starts with the root path, so such a side would match no bucket. The prefix is compared on whole segments.
 */
function rootPrefixProblem(side: string, root: string): string | null {
  const segments = side.split('/');
  if (segments[0] === '**' || root.split('/').every((s, i) => segments[i] === s)) return null;
  return `must start with the root path "${root}" or with "**", because every bucket path starts with "${root}", such as "${root}/billing". If the root folder moved, write the new root path at the start of the line.`;
}

/** Validates the `access` field and puts every line in canonical form. Pushes the problems into `violations`. */
function validateAccess(raw: unknown, root: string, violations: Violation[]): AccessConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    violations.push(invalid('Field "access" must be an object such as {"default": "deny", "allow": ["** -> root/log"]}. Fix it or remove it.'));
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const before = violations.length;
  for (const key of Object.keys(obj)) {
    if (!ACCESS_KEYS.has(key)) {
      violations.push(invalid(`Unknown field "access.${key}" in ${CONFIG_FILE}. Remove it. The allowed fields are default, allow and deny.`));
    }
  }
  if (obj.default !== 'allow' && obj.default !== 'deny') {
    violations.push(invalid('Field "access.default" must be "allow" or "deny". Set it, because it decides the imports that no line matches.'));
  }
  const lists: Record<'allow' | 'deny', string[]> = { allow: [], deny: [] };
  for (const list of ['allow', 'deny'] as const) {
    if (!(list in obj)) continue;
    const items = obj[list];
    if (!Array.isArray(items)) {
      violations.push(invalid(`Field "access.${list}" must be an array of lines such as "root/api/** -> root/log".`));
      continue;
    }
    for (const item of items) {
      if (typeof item !== 'string') {
        violations.push(invalid(`Field "access.${list}" must contain only strings, such as "root/api/** -> root/log".`));
        continue;
      }
      const parsed = parseAccessLine(item);
      if ('error' in parsed) {
        violations.push(invalid(`Field "access.${list}": ${parsed.error}`));
        continue;
      }
      let rootOk = true;
      for (const [side, pattern] of [['left', parsed.line.from], ['right', parsed.line.to]] as const) {
        const problem = rootPrefixProblem(pattern.text, root);
        if (problem === null) continue;
        rootOk = false;
        violations.push(invalid(`Field "access.${list}": the ${side} side "${pattern.text}" of "${parsed.line.text}" ${problem}`));
      }
      if (!rootOk) continue;
      if (lists[list].includes(parsed.line.text)) {
        violations.push(invalid(`Field "access.${list}" lists "${parsed.line.text}" twice. Remove one of them.`));
      } else {
        lists[list].push(parsed.line.text);
      }
    }
  }
  for (const line of lists.deny) {
    if (lists.allow.includes(line)) {
      violations.push(invalid(`Fields "access.allow" and "access.deny" both list "${line}". Remove it from one of them.`));
    }
  }
  if (violations.length > before) return undefined;
  return { default: obj.default as AccessConfig['default'], allow: lists.allow, deny: lists.deny };
}

/** Reads buckets.config.json from the project folder. */
export function loadConfig(projectDir: string): ConfigResult {
  const file = path.join(projectDir, CONFIG_FILE);
  if (!existsSync(file)) return { kind: 'missing' };
  let raw: unknown;
  try {
    raw = parseJson(readFileSync(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'invalid', violations: [invalid(`${CONFIG_FILE} is not valid JSON (${reason}). Fix the syntax.`)] };
  }
  const { config, violations } = validateConfig(raw);
  if (!config) return { kind: 'invalid', violations };
  const onDisk = rootCaseOnDisk(projectDir, config.root);
  if (onDisk !== null) {
    return {
      kind: 'invalid',
      violations: [
        invalid(
          `Field "root" is "${config.root}", but the folder on disk is spelled "${onDisk}". slopbuckets compares paths with their exact case, so every import would look like it leaves the root folder. Set "root" to "${onDisk}", or rename the folder to "${config.root}".`,
        ),
      ],
    };
  }
  return { kind: 'ok', config };
}

/**
 * The spelling of `root` on disk when it differs from the config only in case, as `Root` for a folder
 * named `root` on Windows or macOS. Null when the spelling matches or the folder does not exist.
 */
export function rootCaseOnDisk(projectDir: string, root: string): string | null {
  let dir = projectDir;
  const real: string[] = [];
  let differs = false;
  for (const segment of root.split('/')) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    let name = segment;
    if (!names.includes(segment)) {
      const match = names.find((n) => n.toLowerCase() === segment.toLowerCase());
      if (match === undefined) return null;
      name = match;
      differs = true;
    }
    real.push(name);
    dir = path.join(dir, name);
  }
  return differs ? real.join('/') : null;
}

/** Hash of the resolved config. Formatting and `$schema` do not affect it. */
export function configHash(config: ResolvedConfig): string {
  return sha256(canonicalJson(config));
}

/** The part of the config the adapter protocol carries. */
export function protocolConfig(config: ResolvedConfig): { root: string; alias: string; maxDepth: number } {
  return { root: config.root, alias: config.alias, maxDepth: config.maxDepth };
}

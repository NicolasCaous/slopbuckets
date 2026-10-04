// Loading and validation of buckets.config.json. The rules mirror site/schema/v1.json, checked by hand
// so the CLI has no runtime dependency.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
}

export const DEFAULT_CONFIG: ResolvedConfig = { adapter: 'ts', root: 'root', alias: '@root', maxDepth: 2 };

const ADAPTERS = ['ts'];
const KNOWN_KEYS = new Set(['$schema', 'adapter', 'root', 'alias', 'maxDepth']);

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
      violations.push(invalid(`Unknown field "${key}" in ${CONFIG_FILE}. Remove it. The allowed fields are adapter, root, alias and maxDepth.`));
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

  return violations.length > 0 ? { violations } : { config, violations };
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

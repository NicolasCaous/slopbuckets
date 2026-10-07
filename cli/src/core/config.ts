// Loading and validation of buckets.config.json. The rules mirror site/schema/v1.json, checked by hand
// so the CLI has no runtime dependency.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAccessLine, type AccessConfig } from './access-glob.js';
import { rootPrefixProblem, type GlobLine, type LineLists } from './bucket-glob.js';
import { parseLayoutLine, type LayoutConfig } from './layout-glob.js';
import { canonicalJson, sha256 } from './hash.js';
import { parseJson } from './json.js';
import { JsoncText } from './jsonc.js';
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
  /** Absent when the config has no `layout` key. Then any bucket folder may exist. */
  layout?: LayoutConfig;
}

export const DEFAULT_CONFIG: ResolvedConfig = { adapter: 'ts', root: 'root', alias: '@root', maxDepth: 2 };

const ADAPTERS = ['ts'];
const KNOWN_KEYS = new Set(['$schema', 'adapter', 'root', 'alias', 'maxDepth', 'access', 'layout']);
const LINES_KEYS = new Set(['default', 'allow', 'deny']);

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
      violations.push(invalid(`Unknown field "${key}" in ${CONFIG_FILE}. Remove it. The allowed fields are adapter, root, alias, maxDepth, access and layout.`));
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
    const access = validateLines(ACCESS_KEY, obj.access, config.root, violations);
    if (access) config.access = access;
  }

  if ('layout' in obj) {
    const layout = validateLines(LAYOUT_KEY, obj.layout, config.root, violations);
    if (layout) config.layout = layout;
  }

  return violations.length > 0 ? { violations } : { config, violations };
}

/**
 * A config-invalid violation about `access` or `layout`. An agent reads it too, but only the human may fix the config,
 * so every such message ends by telling the agent to stop.
 */
function ownedInvalid(message: string): Violation {
  return invalid(`${message} ${CONFIG_FILE} belongs to a human, so an AI agent does not fix this, but stops and shows this error to the human.`);
}

/** What differs between the `access` and `layout` keys when they are validated. */
interface LinesKey {
  key: 'access' | 'layout';
  /** An example line, for the messages. */
  example: string;
  /** What `default` decides, for the message about a missing default. */
  decides: string;
  parse: (text: string) => { line: GlobLine } | { error: string };
  /** How a message names pattern `index` of a line, such as `The left side "root/api" of "root/api -> root/log"`. */
  names: (line: GlobLine, index: number) => string;
}

const ACCESS_KEY: LinesKey = {
  key: 'access',
  example: 'root/api/** -> root/log',
  decides: 'the imports that no line matches',
  parse: parseAccessLine,
  names: (line, index) => `The ${index === 0 ? 'left' : 'right'} side "${line.patterns[index]!.text}" of "${line.text}"`,
};

const LAYOUT_KEY: LinesKey = {
  key: 'layout',
  example: 'root/*/*',
  decides: 'the bucket folders that no line matches',
  parse: parseLayoutLine,
  names: (line) => `The line "${line.text}"`,
};

/**
 * Validates the `access` or `layout` field and puts every line in canonical form. Pushes the problems into
 * `violations`.
 */
function validateLines(spec: LinesKey, raw: unknown, root: string, violations: Violation[]): LineLists | undefined {
  const { key, example } = spec;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    violations.push(ownedInvalid(`Field "${key}" must be an object such as {"default": "deny", "allow": ["${example}"]}. Fix it or remove it.`));
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const before = violations.length;
  for (const field of Object.keys(obj)) {
    if (!LINES_KEYS.has(field)) {
      violations.push(ownedInvalid(`Unknown field "${key}.${field}" in ${CONFIG_FILE}. Remove it. The allowed fields are default, allow and deny.`));
    }
  }
  if (obj.default !== 'allow' && obj.default !== 'deny') {
    violations.push(ownedInvalid(`Field "${key}.default" must be "allow" or "deny". Set it, because it decides ${spec.decides}.`));
  }
  const lists: Record<'allow' | 'deny', string[]> = { allow: [], deny: [] };
  for (const list of ['allow', 'deny'] as const) {
    if (!(list in obj)) continue;
    const items = obj[list];
    if (!Array.isArray(items)) {
      violations.push(ownedInvalid(`Field "${key}.${list}" must be an array of lines such as "${example}".`));
      continue;
    }
    for (const item of items) {
      if (typeof item !== 'string') {
        violations.push(ownedInvalid(`Field "${key}.${list}" must contain only strings, such as "${example}".`));
        continue;
      }
      const parsed = spec.parse(item);
      if ('error' in parsed) {
        violations.push(ownedInvalid(`Field "${key}.${list}" has a line that is not valid. ${parsed.error}`));
        continue;
      }
      let rootOk = true;
      parsed.line.patterns.forEach((pattern, index) => {
        const problem = rootPrefixProblem(pattern.text, root);
        if (problem === null) return;
        rootOk = false;
        violations.push(ownedInvalid(`Field "${key}.${list}" has a line that is not valid. ${spec.names(parsed.line, index)} ${problem}`));
      });
      if (!rootOk) continue;
      if (lists[list].includes(parsed.line.text)) {
        violations.push(ownedInvalid(`Field "${key}.${list}" lists "${parsed.line.text}" twice. Remove one of them.`));
      } else {
        lists[list].push(parsed.line.text);
      }
    }
  }
  for (const line of lists.deny) {
    if (lists.allow.includes(line)) {
      violations.push(ownedInvalid(`Fields "${key}.allow" and "${key}.deny" both list "${line}". Remove it from one of them.`));
    }
  }
  if (violations.length > before) return undefined;
  // Sorted, so the order of the lines in the file changes neither the lock nor the config hash.
  return { default: obj.default as LineLists['default'], allow: lists.allow.sort(), deny: lists.deny.sort() };
}

/**
 * The line in buckets.config.json of each access line, keyed by `<list> <canonical line>`, such as
 * `allow root/api -> root/log`. Empty when the file cannot be read or parsed.
 */
export function accessLineNumbers(projectDir: string): Map<string, number> {
  const lines = new Map<string, number>();
  try {
    const doc = new JsoncText(readFileSync(path.join(projectDir, CONFIG_FILE), 'utf8'));
    const access = doc.property(doc.root, 'access')?.value;
    for (const list of ['allow', 'deny'] as const) {
      const items = doc.property(access, list)?.value;
      if (items?.kind !== 'array') continue;
      for (const item of items.items) {
        if (item.kind !== 'value' || typeof item.value !== 'string') continue;
        const parsed = parseAccessLine(item.value);
        const key = `${list} ${'error' in parsed ? item.value : parsed.line.text}`;
        if (!lines.has(key)) lines.set(key, doc.text.slice(0, item.start).split('\n').length);
      }
    }
  } catch {
    // A config that cannot be read here was already reported by loadConfig. The messages just go without a line.
  }
  return lines;
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

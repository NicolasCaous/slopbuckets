// The `config` field of buckets.lock.json: the resolved config itself (version 4) or its hash (versions 1 to 3), and
// what changed between the config of two locks, for `buckets refresh`, `buckets refresh --web` and `buckets check`.
import type { LineLists } from './bucket-glob.js';
import { configHash, type ResolvedConfig } from './config.js';
import { canonicalJson } from './hash.js';
import type { Lock } from './types.js';

/** The config as the lock stores it: a plain object with sorted keys, so it serializes the same way every time. */
export function lockConfig(config: ResolvedConfig): ResolvedConfig {
  return JSON.parse(canonicalJson(config)) as ResolvedConfig;
}

/** The hash of the config of a lock. Locks of versions 1 to 3 store it; for version 4 it is computed from the object. */
export function lockConfigHash(config: Lock['config']): string {
  return typeof config === 'string' ? config : configHash(config);
}

/** True when two locks approved different configs, whatever format each lock stores the config in. */
export function configChanged(previous: Lock['config'], current: Lock['config']): boolean {
  return lockConfigHash(previous) !== lockConfigHash(current);
}

/** The keys of the config made of a default and allow and deny lines. */
export const LINE_KEYS = ['access', 'layout'] as const;
export type LineKey = (typeof LINE_KEYS)[number];

/**
 * One difference between two configs. Every `access` or `layout` line added or removed is its own entry, also when the
 * key as a whole was added or removed. `before` and `after` of a value are JSON text, or null when the key is not set.
 */
export type ConfigChange =
  | { kind: 'section'; key: LineKey; sign: '+' | '-'; default: LineLists['default'] }
  | { kind: 'default'; key: LineKey; before: LineLists['default']; after: LineLists['default'] }
  | { kind: 'line'; key: LineKey; sign: '+' | '-'; list: 'allow' | 'deny'; line: string }
  | { kind: 'value'; key: string; before: string | null; after: string | null };

export interface ConfigDiff {
  /** False when the earlier lock (version 1 to 3) stored only a hash of the config, so the old values are unknown. */
  recorded: boolean;
  /** What changed, in the order of the config keys. Empty when `recorded` is false. */
  changes: ConfigChange[];
}

function isLineKey(key: string): key is LineKey {
  return (LINE_KEYS as readonly string[]).includes(key);
}

function linesOf(lists: LineLists | undefined, list: 'allow' | 'deny'): string[] {
  const lines = lists?.[list];
  return Array.isArray(lines) ? lines : [];
}

function lineChanges(key: LineKey, before: LineLists | undefined, after: LineLists | undefined): ConfigChange[] {
  const out: ConfigChange[] = [];
  if (before === undefined && after !== undefined) out.push({ kind: 'section', key, sign: '+', default: after.default });
  else if (before !== undefined && after === undefined) out.push({ kind: 'section', key, sign: '-', default: before.default });
  else if (before !== undefined && after !== undefined && before.default !== after.default) {
    out.push({ kind: 'default', key, before: before.default, after: after.default });
  }
  for (const list of ['allow', 'deny'] as const) {
    const was = linesOf(before, list);
    const is = linesOf(after, list);
    for (const line of was) if (!is.includes(line)) out.push({ kind: 'line', key, sign: '-', list, line });
    for (const line of is) if (!was.includes(line)) out.push({ kind: 'line', key, sign: '+', list, line });
  }
  return out;
}

/** What changed between the config of two locks. Null when both approved the same config. */
export function configDiff(previous: Lock['config'], current: Lock['config']): ConfigDiff | null {
  if (!configChanged(previous, current)) return null;
  if (typeof previous === 'string' || typeof current === 'string') return { recorded: false, changes: [] };
  const changes: ConfigChange[] = [];
  const before = previous as unknown as Record<string, unknown>;
  const after = current as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    if (isLineKey(key)) {
      changes.push(...lineChanges(key, previous[key], current[key]));
      continue;
    }
    const was = Object.hasOwn(before, key) ? canonicalJson(before[key]) : null;
    const is = Object.hasOwn(after, key) ? canonicalJson(after[key]) : null;
    if (was !== is) changes.push({ kind: 'value', key, before: was, after: is });
  }
  return { recorded: true, changes };
}

/** The label of a config change, the name of what changed: `access.allow`, `layout.default`, `alias`. */
export function configChangeLabel(change: ConfigChange): string {
  switch (change.kind) {
    case 'section':
    case 'value':
      return change.key;
    case 'default':
      return `${change.key}.default`;
    case 'line':
      return `${change.key}.${change.list}`;
  }
}

/** The sign of a config change: + added, - removed, ~ changed. */
export function configChangeSign(change: ConfigChange): '+' | '-' | '~' {
  switch (change.kind) {
    case 'section':
    case 'line':
      return change.sign;
    case 'default':
      return '~';
    case 'value':
      return change.before === null ? '+' : change.after === null ? '-' : '~';
  }
}

/** What a config change did, without its label: the line, or the old and the new value. */
export function configChangeDetail(change: ConfigChange): string {
  switch (change.kind) {
    case 'section':
      return change.sign === '+' ? `added, "default": "${change.default}"` : `removed, it had "default": "${change.default}"`;
    case 'default':
      return `"${change.before}" to "${change.after}"`;
    case 'line':
      return change.line;
    case 'value':
      return change.before === null ? `set to ${change.after}` : change.after === null ? `removed, it was ${change.before}` : `${change.before} to ${change.after}`;
  }
}

/** A config change as a phrase for the message of a `config-changed` lock change. */
export function configChangeText(change: ConfigChange): string {
  switch (change.kind) {
    case 'section':
      return change.sign === '+' ? `added "${change.key}" with "default": "${change.default}"` : `removed "${change.key}", which had "default": "${change.default}"`;
    case 'default':
      return `changed "${change.key}.default" from "${change.before}" to "${change.after}"`;
    case 'line':
      return `${change.sign === '+' ? 'added' : 'removed'} the "${change.key}.${change.list}" line "${change.line}"`;
    case 'value':
      return change.before === null
        ? `set "${change.key}" to ${change.after}`
        : change.after === null
          ? `removed "${change.key}", which was ${change.before}`
          : `changed "${change.key}" from ${change.before} to ${change.after}`;
  }
}

/**
 * Every value of a config as label and text rows, for showing the config a lock approves when the old one is unknown.
 * `access` and `layout` each become one row for their default and one row per line.
 */
export function configRows(config: ResolvedConfig): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const record = config as unknown as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!isLineKey(key)) {
      rows.push({ label: key, value: canonicalJson(record[key]) });
      continue;
    }
    const lists = config[key]!;
    rows.push({ label: `${key}.default`, value: `"${lists.default}"` });
    for (const list of ['allow', 'deny'] as const) for (const line of linesOf(lists, list)) rows.push({ label: `${key}.${list}`, value: line });
  }
  return rows;
}

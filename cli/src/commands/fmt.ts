// `buckets fmt [--check]`: rewrites buckets.config.json, and the configs of its nested projects, in one canonical
// form, so that two edits of the same config differ only where they change something. The merge driver writes the
// same form.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stderrStyle, type Context, type Io } from '../context/index.js';
import { BUCKET_KEYS, CONFIG_FILE, CONFIG_KEYS, EXIT_CODES } from '../contract/index.js';
import { findProjectDir, isRecord, parseJson } from '../files/index.js';
import { parseCommand } from './io.js';

const USAGE = 'Usage: buckets fmt [--check]';

/** Two sides of a key that both branches changed differently. Only the merge driver puts one in a value. */
export class Conflict {
  constructor(
    readonly ours: unknown,
    readonly theirs: unknown,
  ) {}
}

/** A JSON object of the config, not a Conflict of the merge driver. */
const isConfigObject = (v: unknown): v is Record<string, unknown> => isRecord(v) && !(v instanceof Conflict);

/** The keys of `object` in the order of `known`, then the other keys in their own order. */
function ordered(object: Record<string, unknown>, known: readonly string[]): string[] {
  const keys = Object.keys(object);
  return [...known.filter((k) => keys.includes(k)), ...keys.filter((k) => !known.includes(k))];
}

/** The key order of the object at `at`: the schema order at the top and in a bucket, sorted names in maps. */
function keysAt(object: Record<string, unknown>, at: string[]): string[] {
  if (at.length === 0) return ordered(object, CONFIG_KEYS);
  if (at.length === 1 && at[0] === 'buckets') return Object.keys(object).sort();
  if (at.length === 2 && at[0] === 'buckets') return ordered(object, BUCKET_KEYS);
  if (at.length === 3 && at[0] === 'buckets' && (at[2] === 'dependsOn' || at[2] === 'packages')) return Object.keys(object).sort();
  return Object.keys(object);
}

function render(value: unknown, at: string[], indent: string): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length === 1) return `[${render(value[0], at, indent)}]`;
    return `[\n${value.map((item) => `${inner}${render(item, at, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (!isConfigObject(value)) return JSON.stringify(value) ?? 'null';
  const keys = keysAt(value, at);
  if (keys.length === 0) return '{}';
  const lines: string[] = [];
  keys.forEach((key, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    const entry = (v: unknown): string => `${inner}${JSON.stringify(key)}: ${render(v, [...at, key], inner)}${comma}`;
    const v = value[key];
    if (!(v instanceof Conflict)) return void lines.push(entry(v));
    // A side that removed the key shows nothing between its markers.
    lines.push('<<<<<<< ours', ...(v.ours === undefined ? [] : [entry(v.ours)]), '=======', ...(v.theirs === undefined ? [] : [entry(v.theirs)]), '>>>>>>> theirs');
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** The canonical text of a config value: the key orders of keysAt, two-space indent, arrays of two or more items one per line, a final newline. */
export function formatConfig(config: unknown): string {
  return `${render(config, [], '')}\n`;
}

/** The config files of the project at `dir` and of its nested projects, listed in `projects`, recursively. */
function configFiles(dir: string, seen = new Set<string>()): string[] {
  const file = path.join(dir, CONFIG_FILE);
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  let projects: unknown = [];
  try {
    projects = (parseJson(readFileSync(file, 'utf8')) as { projects?: unknown }).projects ?? [];
  } catch {
    // formatting reports the parse error
  }
  const nested = Array.isArray(projects) ? projects.filter((p): p is string => typeof p === 'string') : [];
  return [file, ...nested.flatMap((p) => configFiles(path.join(dir, p), seen))];
}

export async function fmtCommand(_ctx: Context, io: Io, args: string[]): Promise<number> {
  const err = stderrStyle(io);
  const parsed = parseCommand(io, 'fmt', USAGE, args, { check: { type: 'boolean' } });
  if (typeof parsed === 'number') return parsed;
  const { values } = parsed;
  const root = findProjectDir(io.cwd, io.env);
  if (root === null) {
    io.stderr(`${err.error('buckets fmt:')} found no ${CONFIG_FILE} in ${io.cwd} or above it. Run buckets init first.\n`);
    return EXIT_CODES.environment;
  }
  let exitCode: number = EXIT_CODES.ok;
  for (const file of configFiles(root)) {
    const shown = path.relative(io.cwd, file).split(path.sep).join('/') || CONFIG_FILE;
    const text = readFileSync(file, 'utf8');
    let formatted: string;
    try {
      formatted = formatConfig(parseJson(text));
    } catch (error) {
      io.stderr(`${err.error('buckets fmt:')} ${shown} is not valid JSON (${(error as Error).message}), so it was left as it is.\n`);
      exitCode = EXIT_CODES.violations;
      continue;
    }
    if (formatted === text) continue;
    if (values.check) {
      io.stdout(`${shown} is not formatted. Run buckets fmt.\n`);
      exitCode = EXIT_CODES.violations;
    } else {
      writeFileSync(file, formatted, 'utf8');
      io.stdout(`Formatted ${shown}\n`);
    }
  }
  return exitCode;
}

// Helpers that every hook adapter needs to turn a harness payload into the actions of the core: JSON decoding that never
// throws, paths as the harnesses send them, and the file list of an apply_patch style patch.
import { fileURLToPath } from 'node:url';
import { parseJson } from '../core/json.js';

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The JSON object a harness writes on stdin. Anything else, such as invalid JSON or an array, reads as `{}`. */
export function parseHookInput(text: string): JsonRecord {
  try {
    const value: unknown = parseJson(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * The arguments of a tool call, from an object or from a JSON string that holds one. Some harnesses send the
 * arguments as a string (GitHub Copilot's `toolArgs`, Cline's parameters). Anything else reads as `{}`.
 */
export function decodeArgs(value: unknown): JsonRecord {
  if (typeof value === 'string') {
    try {
      value = parseJson(value);
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

/**
 * A path as a harness sends it, made usable by `path.resolve`:
 *
 * - a `file://` URL becomes a path
 * - a Windows workspace root written as `/c:/Users/x` (Cursor) loses the leading slash
 * - backslashes become forward slashes in a Windows path (a drive letter, a `\\?\` prefix, or any path on Windows)
 *
 * Trailing dots, spaces and stream suffixes are kept, because the lock guard reads them.
 */
export function normalizeHarnessPath(value: string): string {
  let out = value;
  if (/^file:\/\//i.test(out)) {
    try {
      out = fileURLToPath(out);
    } catch {
      out = out.replace(/^file:\/\//i, '');
    }
  }
  if (/^\/[A-Za-z]:(?:[\\/]|$)/.test(out)) out = out.slice(1);
  if (process.platform === 'win32' || /^(?:[A-Za-z]:|\\\\)/.test(out)) out = out.replace(/\\/g, '/');
  return out;
}

/** One file header of an apply_patch style patch. `move` is the `*** Move to:` target of an update. */
export interface PatchFile {
  op: 'add' | 'update' | 'delete';
  path: string;
  move?: string;
}

const PATCH_HEADER = /^[ \t]*\*\*\* (Add File|Update File|Delete File|Move to):[ \t]*(.*?)[ \t]*\r?$/;

/**
 * The file headers of a patch in the apply_patch format that Codex, GitHub Copilot, Factory, OpenCode and Cline use:
 * `*** Add File: <path>`, `*** Update File: <path>` (optionally followed by `*** Move to: <path>`) and
 * `*** Delete File: <path>`. Lines that add content start with `+`, so a header inside a file body never matches.
 */
export function parsePatch(patchText: string): PatchFile[] {
  const files: PatchFile[] = [];
  for (const line of patchText.split('\n')) {
    const match = PATCH_HEADER.exec(line);
    if (match === null || match[2] === '') continue;
    const [, kind, file] = match as unknown as [string, string, string];
    if (kind === 'Move to') {
      const last = files[files.length - 1];
      if (last !== undefined && last.op === 'update' && last.move === undefined) last.move = file;
      else files.push({ op: 'add', path: file });
      continue;
    }
    files.push({ op: kind === 'Add File' ? 'add' : kind === 'Update File' ? 'update' : 'delete', path: file });
  }
  return files;
}

/** Every path a patch writes, deletes or moves, sources and targets of a move included, without repeats. */
export function patchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const file of parsePatch(patchText)) {
    for (const p of [file.path, file.move]) if (p !== undefined && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The paths that hold an edited file after the patch applies: added files, updated files and move targets. */
export function patchEditedPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const file of parsePatch(patchText)) {
    if (file.op === 'delete') continue;
    const p = file.move ?? file.path;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

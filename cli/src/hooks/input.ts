// Helpers that every hook adapter needs to turn a harness payload into the actions of the core: JSON decoding that never
// throws and paths as the harnesses send them.
import { fileURLToPath } from 'node:url';
import { isRecord, parseJson, type JsonRecord } from '../files/index.js';

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
 * Trailing dots, spaces and stream suffixes are kept as the harness sent them.
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

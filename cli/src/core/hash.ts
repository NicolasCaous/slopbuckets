import { createHash } from 'node:crypto';

/** Returns `sha256:` followed by the hex digest of the UTF-8 text. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Hash of a text file that ignores the difference between CRLF and LF line endings and a leading UTF-8 byte order
 * mark. Editors add or drop both without changing the content, so neither one makes a file read as changed: no
 * `dmz-changed` in the lock, no new key in the analysis cache.
 */
export function textHash(text: string): string {
  return sha256(normalizeText(text));
}

/** The text that `textHash` hashes: without a leading byte order mark, and with LF line endings. */
export function normalizeText(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n');
}

/**
 * Recursively sorts object keys so that equal values always serialize to the same string. Arrays keep their order.
 * The copies have no prototype, so keys such as `__proto__` stay ordinary keys.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

/** JSON with sorted keys and no whitespace, used as hash input. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

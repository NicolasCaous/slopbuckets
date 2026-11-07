export type JsonRecord = Record<string, unknown>;

/** A JSON object: not null and not an array. */
export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Removes a leading UTF-8 byte order mark. Editors on Windows often save JSON with one, and JSON.parse rejects it. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** JSON.parse that accepts a leading byte order mark. */
export function parseJson(text: string): unknown {
  return JSON.parse(stripBom(text));
}

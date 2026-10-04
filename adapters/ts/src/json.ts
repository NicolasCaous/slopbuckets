// Reading JSON files that editors may save with a UTF-8 byte order mark.

/** Removes a leading U+FEFF. `JSON.parse` rejects it, and Windows editors often write it. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseJson(text: string): unknown {
  return JSON.parse(stripBom(text));
}

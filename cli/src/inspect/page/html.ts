// Safe HTML building without a template engine. Every value interpolated into the `html` tag is escaped,
// unless it is already a SafeHtml produced by `html` or `raw`. File paths and symbol names come from the
// project, so a page must never paste them into markup unescaped.

const SAFE = Symbol('SafeHtml');

export interface SafeHtml {
  readonly [SAFE]: true;
  readonly value: string;
}

export function raw(value: string): SafeHtml {
  return { [SAFE]: true, value };
}

function isSafe(value: unknown): value is SafeHtml {
  return typeof value === 'object' && value !== null && (value as Partial<SafeHtml>)[SAFE] === true;
}

/** Escapes text for element content and for quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (isSafe(value)) return value.value;
  return escapeHtml(String(value));
}

/** Tagged template: `html\`<p>${userText}</p>\`` escapes `userText`. Arrays are joined; null, undefined and false render nothing. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]!) + strings[i + 1]!;
  return raw(out);
}

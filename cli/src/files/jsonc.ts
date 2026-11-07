// In-place edits of JSON files with comments and trailing commas, such as tsconfig.json. The CLI does not bundle
// the TypeScript compiler, so this has its own small parser that keeps the position of every value. An edit replaces,
// inserts or deletes the text of one property, so comments, key order and formatting elsewhere stay as they were. An
// edit that would have to rewrite text holding a comment is refused with UnsafeEdit, and the caller prints what to
// change by hand instead.

export class UnsafeEdit extends Error {}

export interface Span {
  start: number;
  end: number;
}

export type JsonNode = JsonObject | JsonArray | JsonValue;

export interface JsonObject extends Span {
  kind: 'object';
  props: JsonProperty[];
}

export interface JsonArray extends Span {
  kind: 'array';
  items: JsonNode[];
}

export interface JsonValue extends Span {
  kind: 'value';
  value: string | number | boolean | null;
}

export interface JsonProperty extends Span {
  key: string;
  value: JsonNode;
}

class Parser {
  pos = 0;
  readonly comments: Span[] = [];
  constructor(readonly text: string) {}

  fail(what: string): never {
    throw new UnsafeEdit(`it is not valid JSON with comments (${what} at offset ${this.pos})`);
  }

  trivia(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const ch = t[this.pos]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') this.pos++;
      else if (t.startsWith('//', this.pos)) {
        const start = this.pos;
        const end = t.indexOf('\n', this.pos);
        this.pos = end === -1 ? t.length : end;
        this.comments.push({ start, end: this.pos });
      } else if (t.startsWith('/*', this.pos)) {
        const start = this.pos;
        const end = t.indexOf('*/', this.pos + 2);
        if (end === -1) this.fail('an unclosed comment');
        this.pos = end + 2;
        this.comments.push({ start, end: this.pos });
      } else break;
    }
  }

  value(): JsonNode {
    this.trivia();
    const t = this.text;
    const ch = t[this.pos];
    const start = this.pos;
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '"') return { kind: 'value', value: this.string(), start, end: this.pos };
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(t.slice(this.pos));
    if (literal === null) this.fail('an unexpected character');
    this.pos += literal[0].length;
    return { kind: 'value', value: JSON.parse(literal[0]) as string | number | boolean | null, start, end: this.pos };
  }

  string(): string {
    const t = this.text;
    const start = this.pos;
    this.pos++;
    while (this.pos < t.length && t[this.pos] !== '"') this.pos += t[this.pos] === '\\' ? 2 : 1;
    if (this.pos >= t.length) this.fail('an unclosed string');
    this.pos++;
    return JSON.parse(t.slice(start, this.pos)) as string;
  }

  object(): JsonObject {
    const start = this.pos;
    this.pos++;
    const props: JsonProperty[] = [];
    for (;;) {
      this.trivia();
      if (this.text[this.pos] === '}') break;
      if (this.text[this.pos] !== '"') this.fail('a property name that is not a string');
      const keyStart = this.pos;
      const key = this.string();
      this.trivia();
      if (this.text[this.pos] !== ':') this.fail('a missing colon');
      this.pos++;
      const value = this.value();
      props.push({ key, value, start: keyStart, end: value.end });
      this.trivia();
      if (this.text[this.pos] === ',') this.pos++;
      else if (this.text[this.pos] !== '}') this.fail('a missing comma');
    }
    this.pos++;
    return { kind: 'object', props, start, end: this.pos };
  }

  array(): JsonArray {
    const start = this.pos;
    this.pos++;
    const items: JsonNode[] = [];
    for (;;) {
      this.trivia();
      if (this.text[this.pos] === ']') break;
      items.push(this.value());
      this.trivia();
      if (this.text[this.pos] === ',') this.pos++;
      else if (this.text[this.pos] !== ']') this.fail('a missing comma');
    }
    this.pos++;
    return { kind: 'array', items, start, end: this.pos };
  }
}

/** A parsed JSONC text with the positions of its values and comments. Throws UnsafeEdit when it cannot be parsed. */
export class JsoncText {
  readonly text: string;
  readonly root: JsonNode;
  private readonly comments: Span[];
  private readonly bom: boolean;
  readonly newline: string;

  constructor(original: string) {
    this.bom = original.charCodeAt(0) === 0xfeff;
    this.text = this.bom ? original.slice(1) : original;
    this.newline = this.text.includes('\r\n') ? '\r\n' : '\n';
    const parser = new Parser(this.text);
    this.root = parser.value();
    parser.trivia();
    if (parser.pos !== this.text.length) parser.fail('text after the value');
    this.comments = parser.comments;
  }

  /** The last property named `key`, as JSON.parse keeps the last duplicate. */
  property(object: JsonNode | undefined, key: string): JsonProperty | undefined {
    if (object?.kind !== 'object') return undefined;
    let found: JsonProperty | undefined;
    for (const prop of object.props) if (prop.key === key) found = prop;
    return found;
  }

  /** The plain value of a node, as JSON.parse would return it. */
  valueOf(node: JsonNode): unknown {
    if (node.kind === 'value') return node.value;
    if (node.kind === 'array') return node.items.map((item) => this.valueOf(item));
    const out: Record<string, unknown> = {};
    for (const prop of node.props) out[prop.key] = this.valueOf(prop.value);
    return out;
  }

  hasComments(start: number, end: number): boolean {
    return this.comments.some((c) => c.start < end && c.end > start);
  }

  /** The comments that overlap the range, in text order. */
  commentsIn(start: number, end: number): readonly Span[] {
    return this.comments.filter((c) => c.start < end && c.end > start);
  }

  /** Applies edits (non-overlapping ranges) and returns the new text, with the byte order mark kept. */
  apply(edits: { start: number; end: number; text: string }[]): string {
    let text = this.text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return (this.bom ? '﻿' : '') + text;
  }

  lineStart(position: number): number {
    return this.text.lastIndexOf('\n', position - 1) + 1;
  }

  lineEnd(position: number): number {
    const end = this.text.indexOf('\n', position);
    if (end === -1) return this.text.length;
    return this.text[end - 1] === '\r' ? end - 1 : end;
  }

  indentAt(position: number): string {
    return /^[ \t]*/.exec(this.text.slice(this.lineStart(position), position))![0];
  }

  /** The position after whitespace and comments from `from`. */
  skipTrivia(from: number): number {
    let i = from;
    const t = this.text;
    while (i < t.length) {
      if (/\s/.test(t[i]!)) i++;
      else if (t.startsWith('//', i)) i = this.lineEnd(i);
      else if (t.startsWith('/*', i)) {
        const end = t.indexOf('*/', i + 2);
        i = end === -1 ? t.length : end + 2;
      } else break;
    }
    return i;
  }

  /** The position before whitespace and comments that end at `from`. Only whitespace is skipped; a comment stops it. */
  skipSpaceBack(from: number): number {
    let i = from;
    while (i > 0 && /\s/.test(this.text[i - 1]!)) i--;
    return i;
  }
}

function compact(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compact).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${compact(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

export type TextEdit = { start: number; end: number; text: string };

/**
 * The edits that add `entry` (already serialized) as the last member of `container`, an object or an array, in the
 * style of the container. A container with no members but with comments, such as `"paths": { // aliases }`, keeps
 * the comments: the entry goes after the last one.
 */
function appendEdits(doc: JsoncText, container: Span, members: readonly Span[], entry: string, expandEmpty: boolean): TextEdit[] {
  const nl = doc.newline;
  const indent = doc.indentAt(container.start);
  const unit = /^([ \t]+)"/m.exec(doc.text)?.[1] ?? '  ';
  if (members.length === 0) {
    const open = doc.text[container.start]!;
    const close = doc.text[container.end - 1]!;
    if (!doc.hasComments(container.start, container.end)) {
      return [{ start: container.start, end: container.end, text: expandEmpty ? `${open}${nl}${indent}${unit}${entry}${nl}${indent}${close}` : `${open}${entry}${close}` }];
    }
    // Only whitespace is skipped back from the closing bracket, so the entry lands after the last comment, never in it.
    const at = doc.skipSpaceBack(container.end - 1);
    if (!doc.text.slice(container.start, container.end).includes('\n')) return [{ start: at, end: at, text: ` ${entry}` }];
    const ownLine = doc.commentsIn(container.start, container.end).find((c) => doc.text.slice(doc.lineStart(c.start), c.start).trim() === '');
    return [{ start: at, end: at, text: `${nl}${ownLine === undefined ? `${indent}${unit}` : doc.indentAt(ownLine.start)}${entry}` }];
  }
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const multiline = doc.text.slice(container.start, first.start).includes('\n');
  const afterLast = doc.skipTrivia(last.end);
  const trailingComma = doc.text[afterLast] === ',' ? afterLast : -1;
  if (!multiline) {
    return trailingComma === -1 ? [{ start: last.end, end: last.end, text: `, ${entry}` }] : [{ start: trailingComma + 1, end: trailingComma + 1, text: ` ${entry},` }];
  }
  const memberIndent = doc.indentAt(first.start);
  const from = trailingComma === -1 ? last.end : trailingComma + 1;
  const eol = doc.lineEnd(from);
  // Insert at the end of the line when the rest of it is only whitespace and comments, so a comment stays with its member.
  const restIsTrivia = doc.skipTrivia(from) >= eol || doc.text.slice(from, eol).trim() === '';
  const at = restIsTrivia && eol <= container.end - 1 ? eol : from;
  if (trailingComma !== -1) return [{ start: at, end: at, text: `${nl}${memberIndent}${entry},` }];
  if (at === last.end) return [{ start: at, end: at, text: `,${nl}${memberIndent}${entry}` }];
  return [
    { start: last.end, end: last.end, text: ',' },
    { start: at, end: at, text: `${nl}${memberIndent}${entry}` },
  ];
}

/** The edits that delete member `index` of `container`, with its comma. `label` names the member in errors. */
function removeEdits(doc: JsoncText, container: Span, members: readonly Span[], index: number, label: string): TextEdit[] {
  const member = members[index]!;
  if (doc.hasComments(member.start, member.end)) throw new UnsafeEdit(`the entry ${label} contains comments`);
  const afterMember = doc.skipTrivia(member.end);
  const hasComma = doc.text[afterMember] === ',';
  if (hasComma && doc.hasComments(member.end, afterMember)) throw new UnsafeEdit(`a comment follows the entry ${label}`);
  if (hasComma) {
    // A member with a comma after it: delete from the end of the previous line (when the member starts its line)
    // through the comma. A trailing comma after the last member works the same way.
    const lineStart = doc.lineStart(member.start);
    const ownLine = doc.text.slice(lineStart, member.start).trim() === '';
    let start = ownLine && lineStart > container.start ? doc.skipSpaceBack(lineStart) : member.start;
    if (start <= container.start) start = container.start + 1;
    let end = afterMember + 1;
    if (!ownLine) while (doc.text[end] === ' ') end++;
    return [{ start, end, text: '' }];
  }
  // The last member, without a comma: delete from the comma of the previous member through this one.
  if (index === 0) {
    if (doc.hasComments(container.start, container.end)) throw new UnsafeEdit(`the ${doc.text[container.start] === '[' ? 'array' : 'object'} around the entry ${label} contains comments`);
    return [{ start: container.start, end: container.end, text: `${doc.text[container.start]}${doc.text[container.end - 1]}` }];
  }
  const previous = members[index - 1]!;
  const comma = doc.skipTrivia(previous.end);
  if (doc.text[comma] !== ',') throw new UnsafeEdit(`a comment sits before the entry ${label}`);
  if (!doc.hasComments(comma, member.start)) return [{ start: comma, end: member.end, text: '' }];
  // A comment after the comma, such as `"a", // note`, stays with the previous member: delete the comma and the
  // member from the start of its own line, and leave the comment and its line break between them.
  const lineStart = doc.lineStart(member.start);
  if (doc.text.slice(lineStart, member.start).trim() !== '' || lineStart <= comma) throw new UnsafeEdit(`a comment sits before the entry ${label}`);
  // When nothing follows the member on its line, its line break goes too, so no empty line is left.
  const eol = doc.lineEnd(member.end);
  const end = doc.text.slice(member.end, eol).trim() === '' && eol < doc.text.length ? eol + (doc.text[eol] === '\r' ? 2 : 1) : member.end;
  return [
    { start: comma, end: comma + 1, text: '' },
    { start: lineStart, end, text: '' },
  ];
}

/** The edits that set `key` to `value` in `object`: a replaced value, or a new property after the last one. */
export function setPropertyEdits(doc: JsoncText, object: JsonObject, key: string, value: unknown): TextEdit[] {
  const existing = doc.property(object, key);
  const json = compact(value);
  if (existing !== undefined) {
    if (doc.hasComments(existing.value.start, existing.value.end)) throw new UnsafeEdit(`the value of "${key}" contains comments`);
    return [{ start: existing.value.start, end: existing.value.end, text: json }];
  }
  return appendEdits(doc, object, object.props, `${JSON.stringify(key)}: ${json}`, true);
}

/** The edits that delete the property `key` from `object`, with its comma. Empty when the property is absent. */
export function removePropertyEdits(doc: JsoncText, object: JsonObject, key: string): TextEdit[] {
  const index = object.props.findIndex((p) => p.key === key);
  if (index === -1) return [];
  return removeEdits(doc, object, object.props, index, `"${key}"`);
}

/** The edits that add `value` as the last item of `array`. */
export function appendItemEdits(doc: JsoncText, array: JsonArray, value: unknown): TextEdit[] {
  return appendEdits(doc, array, array.items, compact(value), false);
}

/** The edits that delete item `index` of `array`, with its comma. */
export function removeItemEdits(doc: JsoncText, array: JsonArray, index: number): TextEdit[] {
  return removeEdits(doc, array, array.items, index, compact(doc.valueOf(array.items[index]!)));
}

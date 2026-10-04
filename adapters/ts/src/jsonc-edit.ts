// In-place edits of JSON files that may contain comments and trailing commas
// (tsconfig.json, nest-cli.json, package.json). The file is parsed with the
// TypeScript JSON parser for positions only; every edit inserts or replaces the
// text of one property, so comments, key order and formatting stay as they were.

import type * as TS from 'typescript';
import type { TypeScript } from './env.js';
import { stripBom } from './json.js';

/** Thrown when an edit would have to rewrite text that holds comments, or the shape is not an object. */
export class UnsafeEdit extends Error {}

interface Edit {
  start: number;
  end: number;
  text: string;
}

export class JsoncDocument {
  readonly root: TS.ObjectLiteralExpression | undefined;
  readonly parseErrors: string[];
  private readonly source: TS.JsonSourceFile;
  private readonly text: string;
  private readonly bom: boolean;
  private readonly newline: string;
  private readonly unit: string;
  private readonly edits: Edit[] = [];
  private readonly inserts = new Map<TS.ObjectLiteralExpression, [string, unknown][]>();

  constructor(
    private readonly ts: TypeScript,
    fileName: string,
    original: string,
  ) {
    this.bom = original.charCodeAt(0) === 0xfeff;
    this.text = stripBom(original);
    this.newline = this.text.includes('\r\n') ? '\r\n' : '\n';
    this.unit = /^([ \t]+)["/]/m.exec(this.text)?.[1] ?? '  ';
    const source = ts.parseJsonText(fileName, this.text);
    this.source = source;
    const diagnostics = (source as { parseDiagnostics?: TS.Diagnostic[] }).parseDiagnostics ?? [];
    this.parseErrors = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    const expression = source.statements[0]?.expression;
    this.root = expression !== undefined && ts.isObjectLiteralExpression(expression) ? expression : undefined;
  }

  /** The last property named `key`, as JSON.parse keeps the last duplicate. */
  property(object: TS.ObjectLiteralExpression, key: string): TS.PropertyAssignment | undefined {
    let found: TS.PropertyAssignment | undefined;
    for (const property of object.properties) {
      if (this.ts.isPropertyAssignment(property) && this.keyOf(property) === key) found = property;
    }
    return found;
  }

  /** The object value of `key`, undefined when the key is absent. Throws UnsafeEdit when the value is not an object. */
  object(object: TS.ObjectLiteralExpression, key: string): TS.ObjectLiteralExpression | undefined {
    const property = this.property(object, key);
    if (property === undefined) return undefined;
    if (!this.ts.isObjectLiteralExpression(property.initializer)) throw new UnsafeEdit(`"${key}" is not an object`);
    return property.initializer;
  }

  /** Sets `key` to `value`: replaces the value of an existing property, or adds the property at the end of the object. */
  set(object: TS.ObjectLiteralExpression, key: string, value: unknown): void {
    const property = this.property(object, key);
    if (property === undefined) {
      const list = this.inserts.get(object) ?? [];
      list.push([key, value]);
      this.inserts.set(object, list);
      return;
    }
    const initializer = property.initializer;
    if (this.hasComments(initializer.getStart(this.source), initializer.end)) throw new UnsafeEdit(`the value of "${key}" contains comments`);
    this.edits.push({ start: initializer.getStart(this.source), end: initializer.end, text: this.format(value, this.indentAt(property.getStart(this.source))) });
  }

  /** The array value of `key`, undefined when the key is absent. Throws UnsafeEdit when the value is not an array. */
  array(object: TS.ObjectLiteralExpression, key: string): TS.ArrayLiteralExpression | undefined {
    const property = this.property(object, key);
    if (property === undefined) return undefined;
    if (!this.ts.isArrayLiteralExpression(property.initializer)) throw new UnsafeEdit(`"${key}" is not an array`);
    return property.initializer;
  }

  /**
   * Adds `value` at the end of an array, in the style of the array: on its own line in a multi-line array, after a
   * comma in a one-line array, with a trailing comma when the last item has one.
   */
  append(array: TS.ArrayLiteralExpression, value: unknown): void {
    const { newline } = this;
    const open = array.getStart(this.source);
    const close = array.end - 1;
    const items = array.elements;
    const text = this.compact(value);
    if (items.length === 0) {
      if (this.hasComments(open + 1, close)) throw new UnsafeEdit('an empty array holds comments');
      this.edits.push({ start: open, end: array.end, text: `[${text}]` });
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const multiline = this.lineOf(first.getStart(this.source)) !== this.lineOf(open);
    const comma = this.nextComma(last.end, close);
    if (!multiline) {
      if (comma === undefined) this.edits.push({ start: last.end, end: last.end, text: `, ${text}` });
      else this.edits.push({ start: comma + 1, end: comma + 1, text: ` ${text},` });
      return;
    }
    const line = `${newline}${this.indentAt(first.getStart(this.source))}${text}`;
    if (comma !== undefined) {
      const at = this.endOfLineIfTrivia(comma + 1, close);
      this.edits.push({ start: at, end: at, text: `${line},` });
      return;
    }
    const at = this.endOfLineIfTrivia(last.end, close);
    if (at === last.end) {
      this.edits.push({ start: last.end, end: last.end, text: `,${line}` });
      return;
    }
    // A comment after the last item stays on its line; the comma goes before it.
    this.edits.push({ start: last.end, end: last.end, text: ',' }, { start: at, end: at, text: line });
  }

  /** The new text, with the byte order mark kept when the file had one. */
  apply(): string {
    const edits = [...this.edits];
    for (const [object, entries] of this.inserts) edits.push(...this.insertEdits(object, entries));
    edits.sort((a, b) => b.start - a.start);
    let text = this.text;
    for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return (this.bom ? '﻿' : '') + text;
  }

  private insertEdits(object: TS.ObjectLiteralExpression, entries: [string, unknown][]): Edit[] {
    const { newline } = this;
    const open = object.getStart(this.source);
    const close = object.end - 1;
    const properties = object.properties;

    if (properties.length === 0) {
      if (this.hasComments(open + 1, close)) throw new UnsafeEdit('an empty object holds comments');
      const indent = this.indentAt(open);
      const inner = indent + this.unit;
      const body = entries.map(([key, value]) => `${inner}${JSON.stringify(key)}: ${this.format(value, inner)}`).join(`,${newline}`);
      return [{ start: open, end: object.end, text: `{${newline}${body}${newline}${indent}}` }];
    }

    const first = properties[0]!;
    const last = properties[properties.length - 1]!;
    const multiline = this.lineOf(first.getStart(this.source)) !== this.lineOf(open);
    const comma = this.nextComma(last.end, close);

    if (!multiline) {
      const text = entries.map(([key, value]) => `${JSON.stringify(key)}: ${this.compact(value)}`).join(', ');
      return comma === undefined ? [{ start: last.end, end: last.end, text: `, ${text}` }] : [{ start: comma + 1, end: comma + 1, text: ` ${text},` }];
    }

    const indent = this.indentAt(first.getStart(this.source));
    const lines = entries.map(([key, value]) => `${newline}${indent}${JSON.stringify(key)}: ${this.format(value, indent)}`);
    if (comma !== undefined) {
      // Keep the trailing-comma style: every new property ends with a comma too.
      const at = this.endOfLineIfTrivia(comma + 1, close);
      return [{ start: at, end: at, text: lines.map((line) => `${line},`).join('') }];
    }
    const at = this.endOfLineIfTrivia(last.end, close);
    const text = lines.join(',');
    if (at === last.end) return [{ start: last.end, end: last.end, text: `,${text}` }];
    // A comment after the last property stays on its line; the comma goes before it.
    return [
      { start: last.end, end: last.end, text: ',' },
      { start: at, end: at, text },
    ];
  }

  private keyOf(property: TS.PropertyAssignment): string | undefined {
    const name = property.name;
    if (this.ts.isStringLiteral(name) || this.ts.isIdentifier(name) || this.ts.isNumericLiteral(name)) return name.text;
    return undefined;
  }

  /** Position of the comma after `from`, skipping whitespace and comments, if it comes before `limit`. */
  private nextComma(from: number, limit: number): number | undefined {
    const at = this.skipTrivia(from, limit);
    return at < limit && this.text[at] === ',' ? at : undefined;
  }

  private skipTrivia(from: number, limit: number): number {
    let i = from;
    while (i < limit) {
      const ch = this.text[i]!;
      if (/\s/.test(ch)) i++;
      else if (this.text.startsWith('//', i)) i = this.lineEnd(i);
      else if (this.text.startsWith('/*', i)) {
        const end = this.text.indexOf('*/', i + 2);
        i = end === -1 ? limit : end + 2;
      } else break;
    }
    return i;
  }

  /** The end of the line that contains `from`, when the rest of that line is only whitespace and comments; `from` otherwise. */
  private endOfLineIfTrivia(from: number, limit: number): number {
    const end = Math.min(this.lineEnd(from), limit);
    const rest = this.text.slice(from, end);
    if (rest.trim() === '') return from;
    let i = from;
    while (i < end) {
      const ch = this.text[i]!;
      if (ch === ' ' || ch === '\t') i++;
      else if (this.text.startsWith('//', i)) return end;
      else if (this.text.startsWith('/*', i)) {
        const close = this.text.indexOf('*/', i + 2);
        if (close === -1 || close + 2 > end) return from;
        i = close + 2;
      } else return from;
    }
    return end;
  }

  private lineEnd(position: number): number {
    const end = this.text.indexOf('\n', position);
    if (end === -1) return this.text.length;
    return this.text[end - 1] === '\r' ? end - 1 : end;
  }

  private lineOf(position: number): number {
    let line = 0;
    for (let i = 0; i < position; i++) if (this.text[i] === '\n') line++;
    return line;
  }

  private indentAt(position: number): string {
    const start = this.text.lastIndexOf('\n', position - 1) + 1;
    return /^[ \t]*/.exec(this.text.slice(start, position))![0];
  }

  private hasComments(start: number, end: number): boolean {
    const ts = this.ts;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, this.text.slice(start, end));
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
    }
    return false;
  }

  /** JSON for a new value: objects one key per line at `indent`, arrays on one line. */
  private format(value: unknown, indent: string): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.compact(item)).join(', ')}]`;
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) return '{}';
      const inner = indent + this.unit;
      const body = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${this.format(item, inner)}`).join(`,${this.newline}`);
      return `{${this.newline}${body}${this.newline}${indent}}`;
    }
    return JSON.stringify(value);
  }

  private compact(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.compact(item)).join(', ')}]`;
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      return entries.length === 0 ? '{}' : `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${this.compact(item)}`).join(', ')} }`;
    }
    return JSON.stringify(value);
  }
}

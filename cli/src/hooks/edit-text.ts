// The new text of the files an edit tool changes, for every adapter: the guard that keeps a hook from opening a path
// outside the project, find-and-replace edits and apply_patch patches. Every disk read of an edit payload goes through
// readProjectText, because a hook runs before the user's permission prompt.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HookEdit } from '../contract/index.js';
import type { JsonRecord } from '../files/index.js';
import { normalizeHarnessPath } from './input.js';

/** A file larger than this is not read, so the new text of an edit to it stays unknown. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Reserved device names of Windows, with or without an extension. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i;

/**
 * The absolute path of `file`, resolved from `root`, when it lies inside the project at `root`, else null. A UNC path
 * (`\\host\share`, `//host`) and a `\\?\` or `\\.\` device path are null even inside a project on a share, and so is a
 * reserved device name such as NUL on Windows: opening the first sends the user's credentials to that host, and
 * opening a pipe or a device can hang the hook.
 */
export function projectPath(root: string, file: string): string | null {
  const abs = path.resolve(root, file);
  if (/^[\\/]{2}/.test(file) || /^[\\/]{2}/.test(abs)) return null;
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  if (process.platform === 'win32' && rel.split(path.sep).some((segment) => DEVICE.test(segment))) return null;
  return abs;
}

/**
 * The text of a file of the project: null when it does not exist, undefined when it lies outside the project (see
 * projectPath), is not a regular file (a link, a folder, a pipe, a device), is larger than MAX_READ_BYTES or cannot be
 * read.
 * ponytail: lstat then read, so a file swapped for a pipe in between still blocks; open with O_NONBLOCK and fstat if
 * that matters.
 */
export function readProjectText(root: string, file: string): string | null | undefined {
  const abs = projectPath(root, file);
  if (abs === null) return undefined;
  try {
    const stat = lstatSync(abs);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined;
    return readFileSync(abs, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
}

/** An edit of `file`: `content` is the new text, null for a delete, undefined when unknown. */
export function fileEdit(file: string, content: string | null | undefined): HookEdit {
  return content === undefined ? { path: file } : { path: file, content };
}

/** One find-and-replace of an edit tool. `all` replaces every occurrence. */
export interface Replacement {
  old: string;
  new: string;
  all?: boolean;
}

export interface ReplaceOptions {
  /** Without `all`, the old text must occur exactly once, as Claude Code's Edit needs. By default the first one is replaced. */
  unique?: boolean;
  /**
   * What an empty old text does, where the harness documents it: `new-file` writes the new text into a missing or
   * empty file, `whole` replaces the whole file (OpenCode). By default the edit does not apply.
   */
  emptyOld?: 'new-file' | 'whole';
}

/**
 * `text` (null for a missing file) after the replacements, in order, or undefined when the list is empty or one of them
 * does not apply, because the tool then fails or does something this cannot know.
 */
export function replaceText(text: string | null, list: readonly Replacement[], options: ReplaceOptions = {}): string | undefined {
  if (list.length === 0) return undefined;
  let out = text;
  for (const r of list) {
    if (r.old === '') {
      if (options.emptyOld !== 'whole' && !(options.emptyOld === 'new-file' && (out ?? '') === '')) return undefined;
      out = r.new;
      continue;
    }
    const at = out === null ? -1 : out.indexOf(r.old);
    if (out === null || at === -1) return undefined;
    if (r.all === true) out = out.split(r.old).join(r.new);
    else if (options.unique === true && out.includes(r.old, at + r.old.length)) return undefined;
    else out = out.slice(0, at) + r.new + out.slice(at + r.old.length);
  }
  return out ?? undefined;
}

/** The edit of a find-and-replace tool call on `file`, applied to the text on disk. */
export function replaceEdit(root: string, file: string, list: readonly Replacement[], options: ReplaceOptions = {}): HookEdit {
  const text = readProjectText(root, file);
  return fileEdit(file, text === undefined ? undefined : replaceText(text, list, options));
}

// ---------------------------------------------------------------------------------------------------------------
// apply_patch

/** One file of an apply_patch patch, with the lines under its header. `move` is the `*** Move to:` of an update. */
export interface PatchFile {
  op: 'add' | 'update' | 'delete';
  path: string;
  move?: string;
  body: string[];
}

/** Headers start at the first column: a line with a leading space is context of an update, whatever it holds. */
const PATCH_LINE = /^\*\*\* (Add File|Update File|Delete File|Move to):[ \t]*(.*?)[ \t]*$/;
const PATCH_FRAME = /^\*\*\* (?:Begin Patch|End Patch|End of File)[ \t]*$/;
const PATCH_MARK = /^\*\*\* (?:Begin Patch|Add File:|Update File:|Delete File:)/m;

/** True when the text holds an apply_patch patch. */
export function looksLikePatch(text: string): boolean {
  return PATCH_MARK.test(text);
}

/** The patch text of a tool call: the raw arguments string, or the first string argument that holds a patch. */
export function patchTextOf(args: JsonRecord, raw?: unknown): string | undefined {
  if (typeof raw === 'string' && looksLikePatch(raw)) return raw;
  for (const key of ['command', 'patch', 'input', 'patchText', 'patch_text', 'content', ...Object.keys(args)]) {
    const value = args[key];
    if (typeof value === 'string' && looksLikePatch(value)) return value;
  }
  return undefined;
}

/**
 * The files of a patch in the apply_patch format that Codex, GitHub Copilot, Factory, OpenCode and Cline use:
 * `*** Add File: <path>`, `*** Update File: <path>` (optionally followed by `*** Move to: <path>`) and
 * `*** Delete File: <path>`, each with the lines under it.
 */
export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = PATCH_LINE.exec(line);
    if (header !== null && header[2] !== '') {
      const [, kind, file] = header as unknown as [string, string, string];
      const last = files[files.length - 1];
      if (kind === 'Move to' && last?.op === 'update') last.move = file;
      else if (kind !== 'Move to') files.push({ op: kind === 'Add File' ? 'add' : kind === 'Update File' ? 'update' : 'delete', path: file, body: [] });
      continue;
    }
    if (PATCH_FRAME.test(line)) continue;
    files[files.length - 1]?.body.push(line);
  }
  return files;
}

/** The index where `seq` starts in `lines` at or after `from`, comparing with `same`, or -1. */
function findLines(lines: string[], seq: string[], from: number, same: (a: string, b: string) => boolean): number {
  for (let i = from; i + seq.length <= lines.length; i++) if (seq.every((line, j) => same(lines[i + j]!, line))) return i;
  return -1;
}

/**
 * Applies the hunks of an `*** Update File` section to the file text, as Codex's apply_patch reads them: a line that
 * starts with a space is context, `-` is removed, `+` is added, and `@@ text` names a line the hunk comes after, which
 * must exist. Matching tries the exact lines, then ignores trailing spaces, then surrounding spaces. A hunk without old
 * lines adds at the end. The result ends with a line break, in the line ends of the file. Undefined when a hunk does not
 * match.
 */
function applyHunks(text: string, body: string[]): string | undefined {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const hunks: { anchor: string; old: string[]; next: string[] }[] = [];
  for (const line of body) {
    if (line.startsWith('@@')) {
      hunks.push({ anchor: line.slice(2).trim(), old: [], next: [] });
      continue;
    }
    if (hunks.length === 0) hunks.push({ anchor: '', old: [], next: [] });
    const hunk = hunks[hunks.length - 1]!;
    const mark = line[0];
    const rest = line.slice(1);
    if (mark === '-') hunk.old.push(rest);
    else if (mark === '+') hunk.next.push(rest);
    else {
      const context = mark === ' ' ? rest : line;
      hunk.old.push(context);
      hunk.next.push(context);
    }
  }
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.anchor !== '') {
      const at = lines.findIndex((line, i) => i >= cursor && line.trim() === hunk.anchor);
      if (at === -1) return undefined;
      cursor = at + 1;
    }
    if (hunk.old.length === 0) {
      lines.push(...hunk.next);
      cursor = lines.length;
      continue;
    }
    let at = findLines(lines, hunk.old, cursor, (a, b) => a === b);
    if (at === -1) at = findLines(lines, hunk.old, cursor, (a, b) => a.trimEnd() === b.trimEnd());
    if (at === -1) at = findLines(lines, hunk.old, cursor, (a, b) => a.trim() === b.trim());
    if (at === -1) return undefined;
    lines.splice(at, hunk.old.length, ...hunk.next);
    cursor = at + hunk.next.length;
  }
  return lines.join(eol) + eol;
}

/**
 * The files a patch changes, paths resolved from `cwd`, with their new text: an added file holds its `+` lines, a
 * deleted file is null, an updated file is the file on disk with the hunks applied, and a move is a delete plus the new
 * file. An update whose file cannot be read (see readProjectText) or whose hunks do not match has no text.
 */
export function patchEdits(patch: string, cwd: string, root: string): HookEdit[] {
  const out: HookEdit[] = [];
  for (const file of parsePatch(patch)) {
    const abs = path.resolve(cwd, normalizeHarnessPath(file.path));
    if (file.op === 'delete') {
      out.push({ path: abs, content: null });
      continue;
    }
    if (file.op === 'add') {
      const lines = file.body.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
      out.push({ path: abs, content: lines.length === 0 ? '' : `${lines.join('\n')}\n` });
      continue;
    }
    const current = readProjectText(root, abs);
    const content = typeof current === 'string' ? applyHunks(current, file.body) : undefined;
    if (file.move !== undefined) out.push({ path: abs, content: null });
    out.push(fileEdit(file.move === undefined ? abs : path.resolve(cwd, normalizeHarnessPath(file.move)), content));
  }
  return out;
}

// Shared parts of the adapters for harnesses that run hooks as shell commands with JSON on stdin (Codex, Cursor,
// Gemini CLI, GitHub Copilot, Factory, Qwen Code, Auggie, Devin). Two halves:
//
// - run time: the scope of a call, the core action of a tool call from its name and arguments, the files an edit
//   leaves behind, and a "block once" memory for stop events whose payload has no `stop_hook_active`
// - install time: merging hook entries into a JSON config file and removing them again, keeping comments when the
//   file has them (../../core/jsonc.ts) and every entry the user wrote
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Io } from '../../commands/io.js';
import { appendItemEdits, JsoncText, removeItemEdits, removePropertyEdits, setPropertyEdits, type JsonNode } from '../../core/jsonc.js';
import type { Context } from '../../core/types.js';
import type { InstallStep } from '../adapter.js';
import { postEdit, preTool, stop, type HookScope, type StopResult, type ToolAction } from '../core.js';
import { isRecord, normalizeHarnessPath, parseHookInput, patchEditedPaths, patchPaths, str, type JsonRecord } from '../input.js';
import { SESSION_DIR_NAME } from '../session.js';

// ---------------------------------------------------------------------------------------------------------------
// Run time

/** The command a harness config runs for one event of an adapter. */
export function hookCommand(agent: string, event: string): string {
  return `buckets hook --agent ${agent} ${event}`;
}

const SH_GUARD = /^if command -v buckets >\/dev\/null 2>&1; then (.+); fi$/;
const POWERSHELL_GUARD = /^if \(Get-Command buckets -ErrorAction SilentlyContinue\) \{ (.+) \}$/;

/**
 * `command` for sh or bash, run only when the `buckets` command exists. A harness that denies a tool call when its guard
 * hook exits with an error, such as GitHub Copilot, would otherwise deny every call on a machine without the CLI, where
 * the shell exits with 127. With the guard the hook exits with 0 and prints nothing there, so it fails open.
 */
export function failOpenSh(command: string): string {
  return `if command -v buckets >/dev/null 2>&1; then ${command}; fi`;
}

/** `command` for PowerShell, run only when the `buckets` command exists. See failOpenSh. */
export function failOpenPowerShell(command: string): string {
  return `if (Get-Command buckets -ErrorAction SilentlyContinue) { ${command} }`;
}

/** The hook command inside a failOpenSh or failOpenPowerShell guard, or `command` itself. */
export function unwrapFailOpen(command: string): string {
  const text = command.trim();
  return (SH_GUARD.exec(text) ?? POWERSHELL_GUARD.exec(text))?.[1]?.trim() ?? text;
}

/**
 * True when `command` is a hook command of this adapter, for any event, so uninstall also removes older events. A
 * command inside a fail-open guard counts too.
 */
export function isAgentCommand(agent: string, command: unknown): boolean {
  return typeof command === 'string' && new RegExp(`^buckets hook --agent ${agent} [a-z-]+$`).test(unwrapFailOpen(command));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** Writes an unexpected error of a hook call on stderr, in the form every adapter uses. */
export function reportError(io: Io, agent: string, event: string, detail: string): void {
  io.stderr(`buckets hook --agent ${agent} ${event}: unexpected error: ${detail}\n`);
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** The session id of a payload, under any of the names harnesses use. */
export function sessionIdOf(input: JsonRecord): string | undefined {
  return str(input.session_id) ?? str(input.sessionId) ?? str(input.conversation_id) ?? str(input.conversationId);
}

/** The first workspace root of a payload (Cursor, Auggie), normalized. */
export function workspaceRoot(input: JsonRecord): string | undefined {
  const roots = input.workspace_roots ?? input.workspaceRoots;
  if (!Array.isArray(roots)) return undefined;
  const first = roots.find((root): root is string => typeof root === 'string' && root !== '');
  return first === undefined ? undefined : normalizeHarnessPath(first);
}

/**
 * The scope of a hook call: the session folder (an environment variable the harness sets, or `projectDir` from the
 * payload), the working folder (`cwd` of the payload) and the session id. Everything falls back to the process cwd,
 * which is the project folder for harnesses that run hooks from there.
 */
export function scopeOf(input: JsonRecord, io: Io, options: { projectDir?: string | undefined; envVar?: string } = {}): HookScope {
  const fromEnv = options.envVar === undefined ? undefined : str(io.env[options.envVar]);
  const cwdValue = str(input.cwd);
  const cwd = cwdValue === undefined ? undefined : normalizeHarnessPath(cwdValue);
  const projectDir = fromEnv ?? options.projectDir ?? cwd ?? io.cwd;
  const sessionId = sessionIdOf(input);
  return { projectDir, cwd: cwd ?? projectDir, ...(sessionId === undefined ? {} : { sessionId }) };
}

/** What a tool does, as far as the hooks care. `patch` holds apply_patch text; `delete` removes files. */
export type ToolKind = 'shell' | 'write' | 'patch' | 'delete' | 'other';

/** Argument keys that hold one file path, in the spellings the harnesses use. */
const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target_file',
  'targetFile',
  'notebook_path',
  'absolute_path',
  'file',
  'filename',
  'new_path',
  'newPath',
  'old_path',
  'oldPath',
  'source_path',
  'destination',
];
/** Argument keys that hold a list of paths, as strings or as objects with a path. */
const PATH_LIST_KEYS = ['file_paths', 'filePaths', 'paths', 'files'];
/** Argument keys that may hold a shell command. */
const COMMAND_KEYS = ['command', 'cmd', 'command_line', 'commandLine', 'script'];
/** Argument keys that may hold the working folder of a shell command. */
const SHELL_CWD_KEYS = ['cwd', 'dir_path', 'directory', 'workdir', 'working_directory'];

const PATCH_MARK = /^[ \t]*\*\*\* (?:Begin Patch|Add File:|Update File:|Delete File:)/m;

/** True when the text holds an apply_patch style patch. */
export function looksLikePatch(text: string): boolean {
  return PATCH_MARK.test(text);
}

/** Every file path named in the arguments, under the usual keys, normalized. */
export function pathsIn(args: JsonRecord): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    const text = str(value);
    if (text !== undefined && !out.includes(normalizeHarnessPath(text))) out.push(normalizeHarnessPath(text));
  };
  for (const key of PATH_KEYS) add(args[key]);
  for (const key of PATH_LIST_KEYS) {
    const list = args[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isRecord(item)) for (const key2 of PATH_KEYS) add(item[key2]);
      else add(item);
    }
  }
  return out;
}

/** The patch text of a tool call: the raw argument string, or the first string argument that holds a patch. */
export function patchTextOf(args: JsonRecord, raw?: unknown): string | undefined {
  if (typeof raw === 'string' && looksLikePatch(raw)) return raw;
  for (const key of ['command', 'patch', 'input', 'patchText', 'patch_text', 'content', ...Object.keys(args)]) {
    const value = args[key];
    if (typeof value === 'string' && looksLikePatch(value)) return value;
  }
  return undefined;
}

/** The shell command of a tool call. An argv array, as some harnesses send it, is joined with spaces. */
export function commandOf(args: JsonRecord): string | undefined {
  for (const key of COMMAND_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')) return value.join(' ');
  }
  return undefined;
}

function shellCwdOf(args: JsonRecord): string | undefined {
  for (const key of SHELL_CWD_KEYS) {
    const value = str(args[key]);
    if (value !== undefined) return normalizeHarnessPath(value);
  }
  return undefined;
}

const WRITE_WORDS = /write|edit|create|delete|remove|move|rename|patch|replace|save|insert/i;
const SHELL_WORDS = /bash|shell|powershell|pwsh|exec|terminal|command|process/i;
const DELETE_WORDS = /delete|remove/i;

/**
 * The kind of a tool by name: the adapter's table first (case-insensitive), then a guess from the name, so a renamed
 * or new tool that writes files still meets the lock guard. A name that looks like neither is `other`.
 */
export function kindOf(tool: string, table: Record<string, ToolKind>): ToolKind {
  const lower = tool.toLowerCase();
  for (const [name, kind] of Object.entries(table)) if (name.toLowerCase() === lower) return kind;
  if (DELETE_WORDS.test(tool)) return 'delete';
  if (WRITE_WORDS.test(tool)) return 'write';
  if (SHELL_WORDS.test(tool)) return 'shell';
  return 'other';
}

export interface ToolCall {
  /** The core action for the lock guard. */
  action: ToolAction;
  /** The files that hold edited content after the call, for the post-edit check. */
  edited: string[];
}

/**
 * The core action of a tool call and the files it edits. `raw` is the arguments value as the harness sent it, for a
 * harness that may send a patch as a bare string. A write tool's paths include the headers of any patch in its
 * arguments, so a patch never slips past the guard under an unexpected tool name.
 */
export function toolCall(kind: ToolKind, args: JsonRecord, raw?: unknown): ToolCall {
  if (kind === 'other') return { action: { kind: 'other' }, edited: [] };
  if (kind === 'shell') {
    const command = commandOf(args);
    if (command === undefined) return { action: { kind: 'other' }, edited: [] };
    const cwd = shellCwdOf(args);
    return { action: { kind: 'shell', command, ...(cwd === undefined ? {} : { cwd }) }, edited: [] };
  }
  // An editor tool with a `view` command (Copilot's str_replace_editor, Auggie's str-replace-editor) only reads.
  if (args.command === 'view') return { action: { kind: 'other' }, edited: [] };
  const patch = patchTextOf(args, raw);
  const patchAll = patch === undefined ? [] : patchPaths(patch).map(normalizeHarnessPath);
  const patchEdited = patch === undefined ? [] : patchEditedPaths(patch).map(normalizeHarnessPath);
  const named = pathsIn(args);
  const paths = [...new Set([...named, ...patchAll])];
  const edited = kind === 'delete' ? [] : [...new Set([...named, ...patchEdited])];
  return { action: { kind: 'write', paths }, edited };
}

/** The tool call of a payload with `tool_name` and `tool_input` (Claude Code's names, used by most harnesses). */
export function snakeToolCall(input: JsonRecord, table: Record<string, ToolKind>): ToolCall {
  const raw = input.tool_input;
  return toolCall(kindOf(str(input.tool_name) ?? '', table), isRecord(raw) ? raw : {}, raw);
}

/** The edited files that exist on disk, so a moved or deleted file is not checked. */
export function existingFiles(paths: string[], cwd: string): string[] {
  return paths.filter((file) => {
    try {
      return statSync(path.resolve(cwd, file)).isFile();
    } catch {
      return false;
    }
  });
}

/** Cuts a report to `max` characters, for harnesses that cap the context a hook adds. */
export function capText(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[The report is cut here. ${hint}]`;
}

/** The `stop_hook_active` flag of a payload, in snake or camel case, or undefined when the harness sends none. */
export function stopFlag(input: JsonRecord): boolean | undefined {
  const value = input.stop_hook_active ?? input.stopHookActive;
  return typeof value === 'boolean' ? value : undefined;
}

/** A mark older than this does not count, so a block the harness ignored does not skip a later check. */
const MARK_TTL_MS = 60 * 60 * 1000;

function markFile(key: string, baseDir: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(baseDir, SESSION_DIR_NAME, `stop-${hash}.mark`);
}

/**
 * "Block once" for a stop event whose payload says nothing about an earlier block (no `stop_hook_active`). The first
 * stop of `key` runs the check and, when it blocks, leaves a mark; the next stop of `key` finds the mark, removes it
 * and lets the agent finish. So the hook never blocks twice in a row. Every error counts as "no mark".
 */
export const stopMemory = {
  /** True when the last stop of `key` was blocked, and forgets it. */
  takeBlocked(key: string, baseDir: string = os.tmpdir()): boolean {
    const file = markFile(key, baseDir);
    try {
      const fresh = Date.now() - statSync(file).mtimeMs < MARK_TTL_MS;
      rmSync(file, { force: true });
      return fresh;
    } catch {
      return false;
    }
  },
  rememberBlocked(key: string, baseDir: string = os.tmpdir()): void {
    try {
      const file = markFile(key, baseDir);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, '', { mode: 0o600 });
    } catch {
      // Best effort: without the mark the next stop checks again.
    }
  },
};

/**
 * The stop check, blocking at most once in a row. `active` comes from the harness (`stop_hook_active`, a loop count);
 * when the payload has none, the mark of `key` (one session, or one subagent) plays its part.
 */
export async function stopOnce(ctx: Context, scope: HookScope, options: { active: boolean | undefined; subagent: boolean; key: string }): Promise<StopResult> {
  if (options.active !== undefined) return stop(ctx, { ...scope, active: options.active, subagent: options.subagent });
  if (stopMemory.takeBlocked(options.key)) return {};
  const result = await stop(ctx, { ...scope, active: false, subagent: options.subagent });
  if (result.block !== undefined) stopMemory.rememberBlocked(options.key);
  return result;
}

/** What one event of a harness does: guard a tool call, guard a shell command, check edited files, or check at a stop. */
export type Phase = 'pre-tool' | 'pre-shell' | 'post-edit' | 'stop' | 'subagent-stop';

/** The harness specific half of a shell-command adapter: how to read its payload and how to answer. */
export interface RunConfig {
  agent: string;
  /** Each event of `buckets hook --agent <agent> <event>` and what it does. */
  phases: Record<string, Phase>;
  scope(input: JsonRecord, io: Io): HookScope;
  /** The tool call of a `pre-tool` or `post-edit` payload. */
  call(input: JsonRecord): ToolCall;
  /** The shell command of a `pre-shell` payload. */
  shell?(input: JsonRecord): ToolCall;
  /** Writes the allow answer, for a harness that wants one. Most write nothing. */
  allow?(io: Io): void;
  /** Writes the deny answer and returns the exit code. */
  deny(io: Io, reason: string): number;
  /** Writes the post-edit report. */
  feedback(io: Io, text: string): void;
  /** Writes the answer that keeps the agent working with the stop report. */
  block(io: Io, text: string, phase: 'stop' | 'subagent-stop'): void;
  /** `stop_hook_active` or its equivalent; undefined when the payload has none, so the stop mark decides. */
  stopActive(input: JsonRecord, phase: 'stop' | 'subagent-stop'): boolean | undefined;
  /** The key of the stop mark: the session, plus the subagent for a subagent stop. */
  stopKey?(input: JsonRecord, scope: HookScope, phase: 'stop' | 'subagent-stop'): string;
  /** True when this stop must not be checked at all, such as a turn the user aborted. */
  skipStop?(input: JsonRecord): boolean;
}

/**
 * Runs one hook call of a shell-command adapter. It never throws and follows the failure rule of the core: a crash
 * allows the tool call, says nothing after an edit and lets the agent stop (the core already blocks once on a check
 * that crashes inside a project).
 */
export async function runHook(ctx: Context, io: Io, event: string, config: RunConfig): Promise<number> {
  const phase = config.phases[event];
  try {
    const input = parseHookInput(await io.readStdin());
    const scope = config.scope(input, io);
    switch (phase) {
      case 'pre-tool':
      case 'pre-shell': {
        const call = phase === 'pre-shell' && config.shell !== undefined ? config.shell(input) : config.call(input);
        const result = preTool({ ...scope, action: call.action });
        if (result.decision === 'deny') return config.deny(io, result.reason);
        if (result.error !== undefined) reportError(io, config.agent, event, result.error);
        config.allow?.(io);
        return 0;
      }
      case 'post-edit': {
        const paths = existingFiles(config.call(input).edited, path.resolve(scope.projectDir ?? scope.cwd, scope.cwd));
        if (paths.length === 0) return 0;
        const result = await postEdit(ctx, { ...scope, paths });
        if (result.error !== undefined) reportError(io, config.agent, event, result.error);
        if (result.feedback !== undefined) config.feedback(io, result.feedback);
        return 0;
      }
      case 'stop':
      case 'subagent-stop': {
        if (config.skipStop?.(input) === true) return 0;
        const key = config.stopKey?.(input, scope, phase) ?? `${config.agent}:${phase}:${scope.sessionId ?? path.resolve(scope.cwd)}`;
        const result = await stopOnce(ctx, scope, { active: config.stopActive(input, phase), subagent: phase === 'subagent-stop', key });
        if (result.error !== undefined) reportError(io, config.agent, event, result.error);
        if (result.block !== undefined) config.block(io, result.block, phase);
        return 0;
      }
    }
    return 0;
  } catch (error) {
    reportError(io, config.agent, event, errorText(error));
    if (phase === 'pre-tool' || phase === 'pre-shell') config.allow?.(io);
    return 0;
  }
}

/** The Claude Code style deny, which Factory, Qwen Code, Auggie and Devin read. */
export function claudeDenyJson(reason: string): string {
  return jsonLine({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

/** The Claude Code style `decision: block` answer, for post-edit reports and stops. */
export function blockJson(reason: string): string {
  return jsonLine({ decision: 'block', reason });
}

/**
 * The run config of a harness that copies Claude Code's hooks (payload with `tool_name` and `tool_input`, the
 * `hookSpecificOutput` deny, `decision: block`). `denyExit: 2` also writes the reason on stderr and exits with 2, which
 * every Claude-compatible runner reads as a block even when it does not parse the JSON.
 */
export function claudeLikeRun(options: {
  agent: string;
  phases: Record<string, Phase>;
  tools: Record<string, ToolKind>;
  denyExit: 0 | 2;
  /** `block`: `decision: block` with the report as reason. `context`: `hookSpecificOutput.additionalContext`. */
  feedback?: 'block' | 'context';
  envVar?: string;
  /** The session folder from the payload, such as a workspace root. */
  projectDirOf?: (input: JsonRecord) => string | undefined;
}): RunConfig {
  return {
    agent: options.agent,
    phases: options.phases,
    scope: (input, io) => scopeOf(input, io, { projectDir: options.projectDirOf?.(input), ...(options.envVar === undefined ? {} : { envVar: options.envVar }) }),
    call: (input) => snakeToolCall(input, options.tools),
    deny(io, reason) {
      io.stdout(claudeDenyJson(reason));
      if (options.denyExit === 2) io.stderr(`${reason}\n`);
      return options.denyExit;
    },
    feedback(io, text) {
      if (options.feedback === 'context') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
      else io.stdout(blockJson(text));
    },
    block(io, text) {
      io.stdout(blockJson(text));
    },
    stopActive: (input) => stopFlag(input),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Install time

type Key = string | number;

/** The edits install and uninstall make, against a plain value or against JSONC text. */
interface Editor {
  get(keys: Key[]): unknown;
  set(keys: Key[], value: unknown): void;
  append(keys: Key[], value: unknown): void;
  removeItem(keys: Key[], index: number): void;
  removeKey(keys: Key[], key: string): void;
  output(): string;
}

/** Edits a parsed value and writes it back with the indent and line ends of the original text. */
class PlainEditor implements Editor {
  constructor(
    private readonly root: JsonRecord,
    private readonly indent: string,
    private readonly newline: string,
  ) {}

  get(keys: Key[]): unknown {
    let node: unknown = this.root;
    for (const key of keys) {
      if (typeof key === 'number') node = Array.isArray(node) ? node[key] : undefined;
      else node = isRecord(node) ? node[key] : undefined;
    }
    return node;
  }

  set(keys: Key[], value: unknown): void {
    const parent = this.get(keys.slice(0, -1));
    if (isRecord(parent)) parent[keys[keys.length - 1] as string] = structuredClone(value);
  }

  append(keys: Key[], value: unknown): void {
    const list = this.get(keys);
    if (Array.isArray(list)) list.push(structuredClone(value));
  }

  removeItem(keys: Key[], index: number): void {
    const list = this.get(keys);
    if (Array.isArray(list)) list.splice(index, 1);
  }

  removeKey(keys: Key[], key: string): void {
    const parent = this.get(keys);
    if (isRecord(parent)) delete parent[key];
  }

  output(): string {
    return `${JSON.stringify(this.root, null, this.indent).split('\n').join(this.newline)}${this.newline}`;
  }
}

/** Edits JSONC text in place, one change at a time, so comments and formatting elsewhere stay. */
class JsoncEditor implements Editor {
  constructor(private text: string) {}

  private node(doc: JsoncText, keys: Key[]): JsonNode | undefined {
    let node: JsonNode | undefined = doc.root;
    for (const key of keys) {
      if (node === undefined) return undefined;
      if (typeof key === 'number') node = node.kind === 'array' ? node.items[key] : undefined;
      else node = doc.property(node, key)?.value;
    }
    return node;
  }

  private edit(make: (doc: JsoncText) => { start: number; end: number; text: string }[]): void {
    const doc = new JsoncText(this.text);
    const edits = make(doc);
    if (edits.length > 0) this.text = doc.apply(edits);
  }

  get(keys: Key[]): unknown {
    const doc = new JsoncText(this.text);
    const node = this.node(doc, keys);
    return node === undefined ? undefined : doc.valueOf(node);
  }

  set(keys: Key[], value: unknown): void {
    this.edit((doc) => {
      const parent = this.node(doc, keys.slice(0, -1));
      return parent?.kind === 'object' ? setPropertyEdits(doc, parent, keys[keys.length - 1] as string, value) : [];
    });
  }

  append(keys: Key[], value: unknown): void {
    this.edit((doc) => {
      const list = this.node(doc, keys);
      return list?.kind === 'array' ? appendItemEdits(doc, list, value) : [];
    });
  }

  removeItem(keys: Key[], index: number): void {
    this.edit((doc) => {
      const list = this.node(doc, keys);
      return list?.kind === 'array' ? removeItemEdits(doc, list, index) : [];
    });
  }

  removeKey(keys: Key[], key: string): void {
    this.edit((doc) => {
      const parent = this.node(doc, keys);
      return parent?.kind === 'object' ? removePropertyEdits(doc, parent, key) : [];
    });
  }

  output(): string {
    return this.text;
  }
}

/** An editor for the text of a JSON file: plain when it has no comments, JSONC edits when it has. Throws on bad JSON. */
function editorFor(text: string, label: string): Editor {
  const doc = new JsoncText(text.trim() === '' ? '{}' : text);
  if (doc.root.kind !== 'object') throw new Error(`${label} must contain a JSON object`);
  const plain = doc.valueOf(doc.root) as JsonRecord;
  const hasComments = doc.hasComments(0, doc.text.length);
  if (hasComments) return new JsoncEditor(text);
  const indent = /^([ \t]+)["{[]/m.exec(doc.text)?.[1] ?? '  ';
  return new PlainEditor(plain, indent, doc.newline);
}

/** One hook a harness config gets: the entry added to the event's list, and the command that shows it is there. */
export interface HookEntry {
  event: string;
  /** The item appended to the event's list: a group with `hooks` for the `groups` layout, a hook for `flat`. */
  entry: JsonRecord;
  command: string;
}

export interface HookFile {
  /** The harness name, for `isAgentCommand`. */
  agent: string;
  /** The harness title, for messages. */
  title: string;
  /** The config file, relative to the project folder, with forward slashes. */
  file: string;
  /** Keys set at the top of the file when they are missing, such as `{ version: 1 }`. */
  top?: JsonRecord;
  /** The keys from the top of the file to the object that holds the events. Empty for the top itself. */
  container: string[];
  /**
   * `groups`: each event holds groups `{ matcher?, hooks: [ { command } ] }` (Claude Code's shape).
   * `flat`: each event holds hooks `{ command }` directly (Cursor, Copilot).
   */
  layout: 'groups' | 'flat';
  entries: HookEntry[];
  /** True when the file belongs to slopbuckets alone, so uninstall deletes it once it holds no hooks. */
  owned?: boolean;
  /** Keys that older versions put on the adapter's own hook objects and install now removes, such as `failClosed`. */
  staleKeys?: string[];
  /** More changes in the same file, made after the hooks, such as a setting the harness needs. */
  extra?: (editor: { get(keys: Key[]): unknown; set(keys: Key[], value: unknown): void }) => InstallStep[];
}

/** One hook of a harness config before it takes the harness shape. `name` is the slopbuckets event. */
export interface HookDef {
  event: string;
  name: string;
  matcher?: string;
  /** More keys of the hook object, such as a timeout. */
  extra?: JsonRecord;
}

/** Entries in Claude Code's group shape: `{ matcher?, hooks: [{ type: "command", command, ...extra }] }`. */
export function groupEntries(agent: string, defs: HookDef[]): HookEntry[] {
  return defs.map(({ event, name, matcher, extra }) => {
    const command = hookCommand(agent, name);
    return { event, command, entry: { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command, ...extra }] } };
  });
}

/** The command strings of one hook object, under every key a harness uses for one. */
function commandsOfHook(hook: unknown): string[] {
  if (!isRecord(hook)) return [];
  return ['command', 'bash', 'powershell', 'commandWindows'].map((key) => hook[key]).filter((value): value is string => typeof value === 'string');
}

/** The hook objects of one item of an event's list. */
function hooksOfItem(item: unknown, layout: HookFile['layout']): unknown[] {
  if (layout === 'flat') return [item];
  return isRecord(item) && Array.isArray(item.hooks) ? item.hooks : [];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** Merges the hooks of `spec` into its file, idempotently, and reports what changed. */
export function installHookFile(projectDir: string, spec: HookFile): InstallStep[] {
  const file = path.join(projectDir, spec.file);
  try {
    const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const editor = editorFor(original, spec.file);
    for (const [key, value] of Object.entries(spec.top ?? {})) if (editor.get([key]) === undefined) editor.set([key], value);
    for (let i = 0; i < spec.container.length; i++) {
      const keys = spec.container.slice(0, i + 1);
      const value = editor.get(keys);
      if (value === undefined) editor.set(keys, {});
      else if (!isRecord(value)) throw new Error(`"${keys.join('.')}" in ${spec.file} must be an object`);
    }
    const added: string[] = [];
    const replaced = replaceOlderForms(editor, spec);
    for (const hook of spec.entries) {
      const keys = [...spec.container, hook.event];
      const list = editor.get(keys);
      if (list === undefined) {
        editor.set(keys, [hook.entry]);
      } else if (!Array.isArray(list)) {
        throw new Error(`"${keys.join('.')}" in ${spec.file} must be an array`);
      } else if (list.some((item) => hooksOfItem(item, spec.layout).some((h) => commandsOfHook(h).some((c) => c.trim() === hook.command)))) {
        continue;
      } else {
        editor.append(keys, hook.entry);
      }
      if (!added.includes(hook.event)) added.push(hook.event);
    }
    const updated = [...replaced, ...removeStaleKeys(editor, spec).filter((event) => !replaced.includes(event))];
    const extraSteps = spec.extra?.(editor) ?? [];
    // A file whose hooks are all there is not rewritten, even when the plain editor would format it differently.
    if (added.length > 0 || updated.length > 0 || extraSteps.some((step) => step.status === 'done')) writeText(file, editor.output());
    const steps: InstallStep[] = [];
    if (added.length > 0) steps.push({ status: 'done', text: `Installed ${spec.title} hooks in ${spec.file} (${added.join(', ')})` });
    else if (updated.length > 0) steps.push({ status: 'done', text: `Updated the ${spec.title} hooks in ${spec.file} (${updated.join(', ')})` });
    else steps.push({ status: 'kept', text: `${spec.title} hooks are already in ${spec.file}` });
    return [...steps, ...extraSteps];
  } catch (error) {
    return [{ status: 'failed', text: `Could not install the ${spec.title} hooks: ${message(error)}. Fix ${spec.file} and run \`buckets init\` again.` }];
  }
}

/**
 * In the `flat` layout, replaces each hook object of the adapter that runs the same `buckets hook` command as one of
 * the entries but in an older form, such as a Copilot hook written before the fail-open guard, with the current entry.
 * Returns the events it changed.
 */
function replaceOlderForms(editor: Editor, spec: HookFile): string[] {
  const changed: string[] = [];
  if (spec.layout !== 'flat') return changed;
  for (const hook of spec.entries) {
    const keys = [...spec.container, hook.event];
    const list = editor.get(keys);
    if (!Array.isArray(list)) continue;
    const current = commandsOfHook(hook.entry).map((c) => c.trim());
    const inner = unwrapFailOpen(hook.command);
    for (let i = list.length - 1; i >= 0; i--) {
      const commands = commandsOfHook(list[i]);
      const older = commands.some((c) => isAgentCommand(spec.agent, c) && unwrapFailOpen(c) === inner) && commands.some((c) => !current.includes(c.trim()));
      if (!older) continue;
      editor.removeItem(keys, i);
      if (!changed.includes(hook.event)) changed.push(hook.event);
    }
    if (changed.includes(hook.event)) editor.append(keys, hook.entry);
  }
  return changed;
}

/** Removes `spec.staleKeys` from the adapter's own hook objects, never from the user's. Returns the events it changed. */
function removeStaleKeys(editor: Editor, spec: HookFile): string[] {
  const updated: string[] = [];
  const stale = spec.staleKeys ?? [];
  if (stale.length === 0) return updated;
  const container = editor.get(spec.container);
  if (!isRecord(container)) return updated;
  for (const event of Object.keys(container)) {
    const keys = [...spec.container, event];
    const list = editor.get(keys);
    if (!Array.isArray(list)) continue;
    list.forEach((item: unknown, i) => {
      const targets: { hook: unknown; at: Key[] }[] =
        spec.layout === 'flat' ? [{ hook: item, at: [...keys, i] }] : hooksOfItem(item, 'groups').map((hook, h) => ({ hook, at: [...keys, i, 'hooks', h] }));
      for (const { hook, at } of targets) {
        if (!isRecord(hook) || !commandsOfHook(hook).some((c) => isAgentCommand(spec.agent, c))) continue;
        for (const key of stale) {
          if (!(key in hook)) continue;
          editor.removeKey(at, key);
          if (!updated.includes(event)) updated.push(event);
        }
      }
    });
  }
  return updated;
}

/**
 * Removes every hook of the adapter from its file: hook objects whose command is one of the adapter's, groups and
 * events left empty by that, and the events container when it ends up empty. A file left holding only what install
 * put there (`top` and empty containers) is deleted.
 */
export function uninstallHookFile(projectDir: string, spec: HookFile): InstallStep[] {
  const file = path.join(projectDir, spec.file);
  if (!existsSync(file)) return [];
  try {
    const original = readFileSync(file, 'utf8');
    const editor = editorFor(original, spec.file);
    const ours = (hook: unknown): boolean => commandsOfHook(hook).some((command) => isAgentCommand(spec.agent, command));
    const container = editor.get(spec.container);
    const removed: string[] = [];
    if (isRecord(container)) {
      for (const event of Object.keys(container)) {
        const keys = [...spec.container, event];
        const list = editor.get(keys);
        if (!Array.isArray(list)) continue;
        let touched = false;
        for (let i = list.length - 1; i >= 0; i--) {
          const item: unknown = list[i];
          if (spec.layout === 'flat') {
            if (ours(item)) {
              editor.removeItem(keys, i);
              touched = true;
            }
            continue;
          }
          if (!isRecord(item) || !Array.isArray(item.hooks)) continue;
          const hooks: unknown[] = item.hooks;
          const keep = hooks.filter((hook) => !ours(hook));
          if (keep.length === hooks.length) continue;
          touched = true;
          if (keep.length === 0) editor.removeItem(keys, i);
          else for (let h = hooks.length - 1; h >= 0; h--) if (ours(hooks[h])) editor.removeItem([...keys, i, 'hooks'], h);
        }
        if (!touched) continue;
        removed.push(event);
        const after = editor.get(keys);
        if (Array.isArray(after) && after.length === 0) editor.removeKey(spec.container, event);
      }
    }
    if (removed.length === 0) return [{ status: 'kept', text: `${spec.file} has no slopbuckets hooks` }];
    // Containers left empty go, from the innermost out.
    for (let i = spec.container.length; i > 0; i--) {
      const value = editor.get(spec.container.slice(0, i));
      if (isRecord(value) && Object.keys(value).length === 0) editor.removeKey(spec.container.slice(0, i - 1), spec.container[i - 1]!);
    }
    const rest = editor.get([]);
    const leftover = isRecord(rest) ? Object.keys(rest).filter((key) => !(key in (spec.top ?? {}))) : ['?'];
    if (leftover.length === 0 && (spec.owned === true || !new JsoncText(editor.output()).hasComments(0, editor.output().length))) {
      rmSync(file, { force: true });
      return [{ status: 'done', text: `Removed ${spec.file}, which held only the slopbuckets hooks` }];
    }
    writeText(file, editor.output());
    return [{ status: 'done', text: `Removed the slopbuckets hooks from ${spec.file} (${removed.join(', ')})` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove the ${spec.title} hooks: ${message(error)}. Fix ${spec.file} and try again.` }];
  }
}

// The run-time half of the adapters for harnesses that run a shell command with JSON on stdin and read an answer on
// stdout: the contract HookInput of a call (where it runs, the tool, the files it changes with their new text, see
// ../edit-text.ts), the call to the hook core, the "block once" mark for stop events whose payload has no
// stop_hook_active, and runJson, which dispatches an event to the handler of its adapter. The install-time half is
// ./json-install.ts.
import { createHash } from 'node:crypto';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../context/index.js';
import { PHASE_DECISIONS, type HookDecision, type HookEdit, type HookInput, type HookPhase } from '../../contract/index.js';
import { ensureBucketsDir, isRecord, type JsonRecord } from '../../files/index.js';
import { unexpectedError } from '../../output/index.js';
import type { HookAdapter, HookContext } from '../adapter.js';
import { hookCore } from '../core.js';
import { fileEdit, parsePatch, patchEdits, patchTextOf, readProjectText, replaceEdit, type Replacement } from '../edit-text.js';
import { normalizeHarnessPath, parseHookInput, str } from '../input.js';

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** The session id of a payload, under any of the names harnesses use. */
export function sessionIdOf(input: JsonRecord): string | undefined {
  return str(input.session_id) ?? str(input.sessionId) ?? str(input.conversation_id) ?? str(input.conversationId);
}

/** The first workspace root of a payload (Cursor, Auggie, Cline), normalized. */
export function workspaceRoot(input: JsonRecord): string | undefined {
  const roots = input.workspace_roots ?? input.workspaceRoots;
  if (!Array.isArray(roots)) return undefined;
  const first = roots.find((root): root is string => typeof root === 'string' && root !== '');
  return first === undefined ? undefined : normalizeHarnessPath(first);
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

const WRITE_WORDS = /write|edit|create|delete|remove|move|rename|patch|replace|save|insert/i;
const SHELL_WORDS = /bash|shell|powershell|pwsh|exec|terminal|command|process/i;
const DELETE_WORDS = /delete|remove/i;

/**
 * The kind of a tool by name: the adapter's table first (case-insensitive), then a guess from the name, so a renamed
 * or new tool that writes files still reaches the hooks. A name that looks like neither is `other`.
 */
export function kindOf(tool: string, table: Record<string, ToolKind>): ToolKind {
  const lower = tool.toLowerCase();
  for (const [name, kind] of Object.entries(table)) if (name.toLowerCase() === lower) return kind;
  if (DELETE_WORDS.test(tool)) return 'delete';
  if (WRITE_WORDS.test(tool)) return 'write';
  if (SHELL_WORDS.test(tool)) return 'shell';
  return 'other';
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

function markName(key: string): string {
  return `stop-${createHash('sha256').update(key).digest('hex').slice(0, 32)}.mark`;
}

/**
 * "Block once" for a stop event whose payload says nothing about an earlier block (no `stop_hook_active`). The first
 * stop of `key` runs the check and, when it blocks, leaves a mark; the next stop of `key` finds the mark, removes it
 * and lets the agent finish. So the hook never blocks twice in a row. Every error counts as "no mark".
 * The marks live in `<root>/.buckets/sessions/` next to the session state, so each project, and each copy of a
 * project, has its own.
 */
export const stopMemory = {
  /** True when the last stop of `key` in the project at `root` was blocked, and forgets it. */
  takeBlocked(key: string, root: string): boolean {
    const file = path.join(root, '.buckets', 'sessions', markName(key));
    try {
      const fresh = Date.now() - statSync(file).mtimeMs < MARK_TTL_MS;
      rmSync(file, { force: true });
      return fresh;
    } catch {
      return false;
    }
  },
  rememberBlocked(key: string, root: string): void {
    try {
      const dir = ensureBucketsDir(root, 'sessions');
      if (dir !== null) writeFileSync(path.join(dir, markName(key)), '');
    } catch {
      // Best effort: without the mark the next stop checks again.
    }
  },
};

/** The Claude Code style deny, which Factory, Qwen Code, Auggie and Devin read. */
export function claudeDenyJson(reason: string): string {
  return jsonLine({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

/** The fields of a HookInput that every event of a call shares. */
export type Where = Pick<HookInput, 'sessionId' | 'agentId' | 'cwd' | 'root'>;

/** A path from an environment variable the harness sets, such as QWEN_PROJECT_DIR. */
export function envPath(io: Io, name: string): string | undefined {
  const value = str(io.env[name]);
  return value === undefined ? undefined : normalizeHarnessPath(value);
}

/**
 * Where a call runs. `cwd` is the payload's `cwd`, else `root`, else the process folder. `root` is the harness project
 * folder when the adapter knows one, else `cwd`. The agent id is set inside a subagent.
 */
export function whereOf(payload: JsonRecord, io: Io, root?: string): Where {
  const cwdValue = str(payload.cwd);
  const cwd = cwdValue === undefined ? (root ?? io.cwd) : normalizeHarnessPath(cwdValue);
  return {
    sessionId: sessionIdOf(payload) ?? null,
    agentId: str(payload.agent_id) ?? str(payload.agentId) ?? null,
    cwd,
    root: root ?? cwd,
  };
}

/** A tool call: the harness name, what kind of tool it is, its arguments, and the arguments value as the harness sent it. */
export interface ToolCall {
  name: string;
  kind: ToolKind;
  args: JsonRecord;
  raw?: unknown;
}

/** The tool call of a payload with `tool_name` and `tool_input`, Claude Code's names, which most harnesses copy. */
export function snakeCall(payload: JsonRecord, table: Record<string, ToolKind>): ToolCall {
  const name = str(payload.tool_name) ?? '';
  const raw = payload.tool_input;
  return { name, kind: kindOf(name, table), args: isRecord(raw) ? raw : {}, raw };
}

/** The input of a phase without a tool: stop, subagent-stop or post-compact. */
export function eventInput(where: Where, phase: HookPhase, stopHookActive = false): HookInput {
  return { ...where, phase, toolName: null, edits: [], isShell: false, stopHookActive };
}

/** The input of a tool call: pre-edit when it changes files, else pre-tool. */
export function toolInput(where: Where, name: string, edits: HookEdit[], isShell: boolean): HookInput {
  return { ...where, phase: edits.length > 0 ? 'pre-edit' : 'pre-tool', toolName: name === '' ? null : name, edits, isShell, stopHookActive: false };
}

/** The input of a call before the tool runs: pre-edit with the new text of each file when the tool edits files, else pre-tool. */
export function beforeTool(where: Where, call: ToolCall): HookInput {
  return toolInput(where, call.name, plannedEdits(call, where), call.kind === 'shell');
}

/**
 * The input of a call after the tool ran, for a harness that can only add text after the tool (the post-tool
 * fallback). A tool that edits files becomes a pre-edit whose files hold what is on disk now; `changed` overrides that
 * when the payload carries the new text. Any other tool is a pre-tool.
 */
export function afterTool(where: Where, call: ToolCall, changed?: HookEdit[]): HookInput {
  const edits =
    changed !== undefined && changed.length > 0
      ? changed
      : call.kind === 'other' || call.kind === 'shell'
        ? []
        : touchedPaths(call).map((file) => {
            const abs = path.resolve(where.cwd, file);
            return fileEdit(abs, readProjectText(where.root, abs));
          });
  return { ...toolInput(where, call.name, edits, call.kind === 'shell'), applied: true };
}

/** Argument keys that hold the whole new text of a file. */
const CONTENT_KEYS = ['content', 'file_text', 'file_content', 'contents'];
/** Argument key pairs that hold a replacement: the old text and the new text. */
const REPLACE_KEYS: [string, string][] = [
  ['old_string', 'new_string'],
  ['old_str', 'new_str'],
  ['before', 'after'],
];

/** Every path the call writes, deletes or moves, as the payload names them. */
function touchedPaths(call: ToolCall): string[] {
  if (call.args.command === 'view') return [];
  const patch = patchTextOf(call.args, call.raw);
  const named = pathsIn(call.args);
  if (patch !== undefined && (call.kind === 'patch' || named.length === 0)) {
    return parsePatch(patch).flatMap((file) => (file.move === undefined ? [file.path] : [file.path, file.move]));
  }
  return named;
}

/** The files a write, patch or delete tool will change, with their new text when the payload and the disk give it. */
function plannedEdits(call: ToolCall, where: Where): HookEdit[] {
  if (call.kind === 'other' || call.kind === 'shell' || call.args.command === 'view') return [];
  if (call.kind === 'delete') return pathsIn(call.args).map((file) => ({ path: path.resolve(where.cwd, file), content: null }));
  // A write tool's own text may look like a patch (a doc about apply_patch), so a patch counts only for a patch tool or
  // a call that names no file.
  const patch = patchTextOf(call.args, call.raw);
  const file = pathsIn(call.args)[0];
  if (patch !== undefined && (call.kind === 'patch' || file === undefined)) return patchEdits(patch, where.cwd, where.root);
  if (file === undefined) return [];
  const abs = path.resolve(where.cwd, file);
  for (const key of CONTENT_KEYS) {
    const value = call.args[key];
    if (typeof value === 'string') return [{ path: abs, content: value }];
  }
  const list = replacements(call.args);
  return [list === undefined ? { path: abs } : replaceEdit(where.root, abs, list)];
}

/**
 * The replacements in `args`: one pair under the usual keys, or numbered pairs (`old_str_1`, `new_str_1`, ...).
 * `replace_all` or `allow_multiple` replaces every occurrence, else the first. Undefined when a pair is not two strings.
 */
export function replacements(args: JsonRecord): Replacement[] | undefined {
  const pairs: [unknown, unknown][] = REPLACE_KEYS.map(([a, b]) => [args[a], args[b]]);
  for (let i = 1; args[`old_str_${i}`] !== undefined; i++) pairs.push([args[`old_str_${i}`], args[`new_str_${i}`]]);
  const all = args.replace_all === true || args.allow_multiple === true;
  const list: Replacement[] = [];
  for (const [from, to] of pairs) {
    if (from === undefined && to === undefined) continue;
    if (typeof from !== 'string' || typeof to !== 'string') return undefined;
    list.push({ old: from, new: to, all });
  }
  return list;
}

/**
 * Calls the core and keeps its answer inside what the phase allows, so an adapter never prints an answer its event
 * cannot carry. Empty text is silent. A stop that already follows a block never blocks again, whatever the core says.
 */
export async function decide(ctx: HookContext, input: HookInput): Promise<HookDecision> {
  const decision = await (ctx.hookCore ?? hookCore)(input, ctx.engine);
  if (!PHASE_DECISIONS[input.phase].includes(decision.kind)) return { kind: 'silent' };
  if (decision.kind !== 'silent' && decision.text === '') return { kind: 'silent' };
  if (decision.kind === 'block' && input.stopHookActive) return { kind: 'silent' };
  return decision;
}

/**
 * The deny reason for an edit, before it runs, for a harness that shows text only after the tool (the post-tool
 * fallback shows the pending list). The core runs without a session id, so it keeps no memory and nothing counts as
 * shown before the post-tool hook shows it. Undefined for a call that edits nothing or that the core lets through.
 */
export async function denyBeforeEdit(ctx: HookContext, where: Where, call: ToolCall): Promise<string | undefined> {
  const input = beforeTool(where, call);
  if (input.phase !== 'pre-edit') return undefined;
  const decision = await decide(ctx, { ...input, sessionId: null, agentId: null });
  return decision.kind === 'deny' ? decision.text : undefined;
}

/**
 * The stop check for a harness whose payload has no stop_hook_active: a mark per `key` (a session, or a subagent)
 * stands in for the flag. A stop right after a blocked one goes to the core as active and forgets the mark.
 */
export async function decideStopByMark(ctx: HookContext, input: HookInput, key: string): Promise<HookDecision> {
  const active = stopMemory.takeBlocked(key, input.root);
  const decision = await decide(ctx, { ...input, stopHookActive: active });
  if (decision.kind === 'block') stopMemory.rememberBlocked(key, input.root);
  return decision;
}

/**
 * Runs one hook call of `adapter`: parses the payload on stdin and hands it to the handler of `event`, which calls the
 * core, prints the answer and returns the exit code. This never throws: an error goes to stderr, the neutral answer of
 * the event (the one that lets everything go on, empty for most harnesses) goes to stdout and the exit code is 0, so a
 * crash never denies a tool or keeps an agent from stopping.
 */
export async function runJson(ctx: HookContext, io: Io, adapter: HookAdapter, event: string): Promise<number> {
  try {
    const handler = adapter.handlers[event];
    if (handler === undefined) throw new Error(`${adapter.title} has no "${event}" event`);
    return await handler(ctx, io, parseHookInput(await io.readStdin()));
  } catch (error) {
    io.stderr(unexpectedError(`buckets hook --agent ${adapter.name} ${event}`, error));
    const neutral = adapter.neutral?.[event];
    if (neutral !== undefined) io.stdout(neutral);
    return 0;
  }
}

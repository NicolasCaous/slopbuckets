// The Auggie adapter (Augment's CLI). Auggie reads the "hooks" key of `.augment/settings.json` in Claude Code's shape,
// with timeouts in milliseconds, and sends `conversation_id` and `workspace_roots`. Its tools are launch-process,
// save-file, str-replace-editor (`old_str_1`, `new_str_1`, ...) and remove-files.
//
// PreToolUse reads only a deny, so the pending list goes out by the post-tool fallback: PostToolUse runs the pre-tool
// phase (or a pre-edit with the new text from `file_changes`) and answers `additionalContext`. The PreToolUse hook on
// edits only denies an edit that would make buckets.config.json invalid; it runs the core without a session id, so
// nothing counts as shown before PostToolUse shows it. Stop has no stop_hook_active, so a mark per conversation blocks
// once, and only a stop with `agent_stop_cause: "end_turn"` is checked. Auggie has no subagent or compaction event.
//
// Auggie runs `command` through the system shell, /bin/sh on macOS and Linux and cmd.exe on Windows. Both read
// `buckets hook --agent auggie <event> || exit 0` the same way, so the settings are the same on every system, and a
// machine without the `buckets` command exits 0. Exit codes other than 0 and 2 are non-blocking errors anyway.
import path from 'node:path';
import type { Io } from '../../context/index.js';
import type { HookDecision, HookEdit } from '../../contract/index.js';
import { isRecord, type JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler } from '../adapter.js';
import { str } from '../input.js';
import { DEFAULT_COMMAND, groupEntries, installHooks, isAgentCommand, type JsonHookFile, uninstallHooks } from './json-install.js';
import {
  afterTool,
  claudeDenyJson,
  decide,
  decideStopByMark,
  denyBeforeEdit,
  envPath,
  eventInput,
  jsonLine,
  snakeCall,
  type ToolKind,
  type Where,
  whereOf,
  workspaceRoot,
} from './json-run.js';

const AGENT = 'auggie';

const TOOLS: Record<string, ToolKind> = {
  'launch-process': 'shell',
  'save-file': 'write',
  'str-replace-editor': 'write',
  'remove-files': 'delete',
  view: 'other',
  'codebase-retrieval': 'other',
  'web-fetch': 'other',
};

/** The files of a PostToolUse `file_changes` list with their new text: null for a deleted file. */
function fileChanges(payload: JsonRecord, where: Where): HookEdit[] {
  const list = payload.file_changes;
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord).flatMap((change): HookEdit[] => {
    const file = str(change.path);
    if (file === undefined) return [];
    const abs = path.resolve(where.cwd, file);
    if (/delete|remove/i.test(String(change.changeType))) return [{ path: abs, content: null }];
    return typeof change.content === 'string' ? [{ path: abs, content: change.content }] : [{ path: abs }];
  });
}

function printStop(io: Io, decision: HookDecision): void {
  if (decision.kind !== 'block') return;
  // The docs show decision and reason inside hookSpecificOutput for Stop; the top-level form is Claude Code's. Both go
  // out until a live test shows which one Auggie reads.
  io.stdout(jsonLine({ decision: 'block', reason: decision.text, hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason: decision.text } }));
}

const where = (payload: JsonRecord, io: Io): Where => whereOf(payload, io, envPath(io, 'AUGMENT_PROJECT_DIR') ?? workspaceRoot(payload));

const preToolUse: HookHandler = async (ctx, io, payload) => {
  const reason = await denyBeforeEdit(ctx, where(payload, io), snakeCall(payload, TOOLS));
  if (reason !== undefined) io.stdout(claudeDenyJson(reason));
  return 0;
};

const postToolUse: HookHandler = async (ctx, io, payload) => {
  const at = where(payload, io);
  const decision = await decide(ctx, afterTool(at, snakeCall(payload, TOOLS), fileChanges(payload, at)));
  if (decision.kind === 'context') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: decision.text } }));
  return 0;
};

const stop: HookHandler = async (ctx, io, payload) => {
  // An interrupted turn, an error or the iteration limit ends without a check.
  if (payload.agent_stop_cause !== undefined && payload.agent_stop_cause !== 'end_turn') return 0;
  const at = where(payload, io);
  printStop(io, await decideStopByMark(ctx, eventInput(at, 'stop'), `${AGENT}:stop:${at.sessionId ?? at.cwd}`));
  return 0;
};

// ---------------------------------------------------------------------------------------------------------------
// Install

export function auggieHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: AGENT,
    title: 'Auggie',
    file: '.augment/settings.json',
    container: ['hooks'],
    layout: 'groups',
    // The 1.x entries ran the bare hook command, so they count as ours and get replaced.
    ours: (command) => isAgentCommand(AGENT, command.replace(/\s*\|\|\s*exit 0\s*$/, '')),
    entries: groupEntries(
      AGENT,
      [
        { event: 'PreToolUse', name: 'pre-tool-use', matcher: 'save-file|str-replace-editor|remove-files', extra: { timeout: 60_000 } },
        { event: 'PostToolUse', name: 'post-tool-use', extra: { timeout: 60_000 } },
        { event: 'Stop', name: 'stop', extra: { timeout: 600_000 } },
      ],
      cli,
      (command) => `${command} || exit 0`,
    ),
  };
}

export const auggieAdapter = defineAdapter({
  name: AGENT,
  title: 'Auggie',
  markers: ['.augment'],
  hookFiles: [auggieHooks().file],
  handlers: { 'pre-tool-use': preToolUse, 'post-tool-use': postToolUse, stop },
  install: (projectDir, options) => installHooks(projectDir, auggieHooks(options.command)),
  uninstall: (projectDir) => uninstallHooks(projectDir, auggieHooks()),
});

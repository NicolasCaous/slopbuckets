// The Devin adapter, for Devin Local in Devin Desktop and the Devin CLI, which share one hook system. Devin reads
// `.devin/hooks.v1.json`, where the whole file is the hooks object (no "hooks" wrapper key). The tools are lowercase:
// write, edit, apply_patch, notebook_edit, exec, read and others; their argument names are not documented, so paths and
// text are read under every usual key.
//
// PreToolUse `additionalContext` is not documented, so the pending list goes out by the post-tool fallback: PostToolUse
// runs the pre-tool phase (or a pre-edit of the files as they are now) and answers `additionalContext`. The PreToolUse
// hook on edits only denies an edit that would make buckets.config.json invalid, with exit 2 and the reason on stderr;
// it runs the core without a session id, so nothing counts as shown before PostToolUse shows it. `decision: "approve"`
// allows a call and is never printed. Stop blocks once with stop_hook_active. PostCompact runs after a compaction.
// Devin has no subagent stop event. Other exit codes, timeouts and bad output do not block, so a missing `buckets`
// fails open.
import type { Io } from '../../context/index.js';
import { JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler } from '../adapter.js';
import { anchoredCommand, DEFAULT_COMMAND, groupEntries, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { afterTool, decide, denyBeforeEdit, envPath, eventInput, jsonLine, snakeCall, stopFlag, type ToolKind, type Where, whereOf } from './json-run.js';

const AGENT = 'devin';

const TOOLS: Record<string, ToolKind> = {
  exec: 'shell',
  write: 'write',
  edit: 'write',
  notebook_edit: 'write',
  apply_patch: 'patch',
  read: 'other',
  grep: 'other',
  glob: 'other',
  webfetch: 'other',
};

const where = (payload: JsonRecord, io: Io): Where => whereOf(payload, io, envPath(io, 'DEVIN_PROJECT_DIR'));

const preToolUse: HookHandler = async (ctx, io, payload) => {
  const reason = await denyBeforeEdit(ctx, where(payload, io), snakeCall(payload, TOOLS));
  if (reason === undefined) return 0;
  io.stderr(`${reason}\n`);
  return 2;
};

const postToolUse: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, afterTool(where(payload, io), snakeCall(payload, TOOLS)));
  if (decision.kind === 'context') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: decision.text } }));
  return 0;
};

const stop: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, eventInput(where(payload, io), 'stop', stopFlag(payload) === true));
  if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
  return 0;
};

const postCompact: HookHandler = async (ctx, io, payload) => {
  await decide(ctx, eventInput(where(payload, io), 'post-compact'));
  return 0;
};

export function devinHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: AGENT,
    title: 'Devin',
    file: '.devin/hooks.v1.json',
    container: [],
    layout: 'groups',
    entries: groupEntries(
      AGENT,
      [
        { event: 'PreToolUse', name: 'pre-tool-use', matcher: '^(write|edit|apply_patch|notebook_edit)$', extra: { timeout: 60 } },
        { event: 'PostToolUse', name: 'post-tool-use', matcher: '', extra: { timeout: 60 } },
        { event: 'Stop', name: 'stop', extra: { timeout: 600 } },
        { event: 'PostCompact', name: 'post-compact', extra: { timeout: 30 } },
      ],
      cli,
    ),
  };
}

export const devinAdapter = defineAdapter({
  name: AGENT,
  title: 'Devin',
  markers: ['.devin'],
  hookFiles: [devinHooks().file],
  handlers: { 'pre-tool-use': preToolUse, 'post-tool-use': postToolUse, stop, 'post-compact': postCompact },
  install: (projectDir, options) => installHooks(projectDir, devinHooks(anchoredCommand(options.command, 'DEVIN_PROJECT_DIR'))),
  uninstall: (projectDir) => uninstallHooks(projectDir, devinHooks()),
});

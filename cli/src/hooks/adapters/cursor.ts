// The Cursor adapter, for the editor and the cursor-agent CLI. Cursor reads `.cursor/hooks.json`, where each event
// holds hooks directly, and sends `conversation_id` and `workspace_roots`.
//
// preToolUse has no field that adds context, so the pending list goes out by the post-tool fallback: postToolUse runs
// the pre-tool phase (or a pre-edit of the files as they are now) and answers `additional_context`, which reaches the
// model from Cursor 3.9.8. The preToolUse hook on Write and Delete only denies an edit that would make
// buckets.config.json invalid; it runs the core without a session id, so nothing counts as shown before postToolUse
// shows it. Its other answer is `{}`, never `allow`: only deny counts today, but an open Cursor ticket would make allow
// skip the user's approval. stop and subagentStop answer `followup_message` once, guarded by `loop_count` and
// `loop_limit: 1`. Cursor has no event after a compaction.
//
// Exit codes other than 0 and 2 fail open, so a missing `buckets` command lets every call through; every error path
// here exits with 0 and the neutral answer.
import type { Io } from '../../context/index.js';
import { JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler } from '../adapter.js';
import { DEFAULT_COMMAND, hookCommand, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { afterTool, decide, denyBeforeEdit, eventInput, jsonLine, snakeCall, type ToolKind, type Where, whereOf, workspaceRoot } from './json-run.js';

const AGENT = 'cursor';

/** Cursor tool types. Its Claude compatibility maps Edit and Write to Write, and Bash to Shell. */
const TOOLS: Record<string, ToolKind> = {
  Shell: 'shell',
  Write: 'write',
  Delete: 'delete',
  Read: 'other',
  Grep: 'other',
  Glob: 'other',
  LS: 'other',
  Task: 'other',
};

/** The preToolUse answer that changes nothing. */
const NEUTRAL = jsonLine({});

const USER_MESSAGE = 'slopbuckets denied this edit because buckets.config.json would become invalid. The agent got the details.';

const where = (payload: JsonRecord, io: Io): Where => whereOf(payload, io, workspaceRoot(payload));

const preToolUse: HookHandler = async (ctx, io, payload) => {
  const reason = await denyBeforeEdit(ctx, where(payload, io), snakeCall(payload, TOOLS));
  io.stdout(reason === undefined ? NEUTRAL : jsonLine({ permission: 'deny', agent_message: reason, user_message: USER_MESSAGE }));
  return 0;
};

const postToolUse: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, afterTool(where(payload, io), snakeCall(payload, TOOLS)));
  if (decision.kind === 'context') io.stdout(jsonLine({ additional_context: decision.text }));
  return 0;
};

function stop(phase: 'stop' | 'subagent-stop'): HookHandler {
  return async (ctx, io, payload) => {
    // A turn the user aborted ends without a check; a subagent is checked only when it completed.
    if (payload.status === 'aborted' || (phase === 'subagent-stop' && payload.status !== undefined && payload.status !== 'completed')) return 0;
    const active = typeof payload.loop_count === 'number' && payload.loop_count > 0;
    const decision = await decide(ctx, eventInput(where(payload, io), phase, active));
    if (decision.kind === 'block') io.stdout(jsonLine({ followup_message: decision.text }));
    return 0;
  };
}

export function cursorHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  const hook = (name: string, extra: Record<string, unknown>) => ({ command: hookCommand(AGENT, name, cli), ...extra });
  return {
    agent: AGENT,
    title: 'Cursor',
    file: '.cursor/hooks.json',
    top: { version: 1 },
    container: ['hooks'],
    layout: 'flat',
    entries: [
      { event: 'preToolUse', entry: hook('pre-tool-use', { matcher: 'Write|Delete', timeout: 60 }) },
      { event: 'postToolUse', entry: hook('post-tool-use', { timeout: 60 }) },
      { event: 'stop', entry: hook('stop', { loop_limit: 1, timeout: 600 }) },
      { event: 'subagentStop', entry: hook('subagent-stop', { loop_limit: 1, timeout: 600 }) },
    ].map((item) => ({ ...item, command: item.entry.command })),
  };
}

export const cursorAdapter = defineAdapter({
  name: AGENT,
  title: 'Cursor',
  markers: ['.cursor', '.cursorrules'],
  handlers: { 'pre-tool-use': preToolUse, 'post-tool-use': postToolUse, stop: stop('stop'), 'subagent-stop': stop('subagent-stop') },
  neutral: { 'pre-tool-use': NEUTRAL },
  install: (projectDir, options) => installHooks(projectDir, cursorHooks(options.command)),
  uninstall: (projectDir) => uninstallHooks(projectDir, cursorHooks()),
});

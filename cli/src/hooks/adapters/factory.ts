// The Factory Droid adapter. Droid reads `.factory/hooks.json`, whose top level holds the events in Claude Code's
// group shape, and sends Claude-like payloads with FACTORY_PROJECT_DIR set. A PreToolUse `allow` can skip Droid's own
// permission prompt, so the pre hook only denies or says nothing.
//
// Whether PreToolUse `additionalContext` reaches the model is not documented, so the pending list goes out by the
// post-tool fallback: PostToolUse runs the pre-tool phase (or a pre-edit of the files as they are now) and answers
// `additionalContext`. The PreToolUse hook on Create, Edit and ApplyPatch only denies an edit that would make
// buckets.config.json invalid; it runs the core without a session id, so nothing counts as shown before PostToolUse
// shows it. Stop and SubagentStop block once with stop_hook_active. SessionStart with source `compact` is the event
// after a compaction. Exit codes other than 0 and 2 are non-blocking errors, so a missing `buckets` fails open.
import type { Io } from '../../context/index.js';
import { JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler } from '../adapter.js';
import { anchoredCommand, DEFAULT_COMMAND, groupEntries, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import {
  afterTool,
  claudeDenyJson,
  decide,
  denyBeforeEdit,
  envPath,
  eventInput,
  jsonLine,
  snakeCall,
  stopFlag,
  type ToolKind,
  type Where,
  whereOf,
} from './json-run.js';

const AGENT = 'factory';

const TOOLS: Record<string, ToolKind> = {
  Execute: 'shell',
  Create: 'write',
  Edit: 'write',
  ApplyPatch: 'patch',
  Read: 'other',
  LS: 'other',
  Grep: 'other',
  Glob: 'other',
  Task: 'other',
  TodoWrite: 'other',
};

const where = (payload: JsonRecord, io: Io): Where => whereOf(payload, io, envPath(io, 'FACTORY_PROJECT_DIR'));

const preToolUse: HookHandler = async (ctx, io, payload) => {
  const reason = await denyBeforeEdit(ctx, where(payload, io), snakeCall(payload, TOOLS));
  if (reason !== undefined) io.stdout(claudeDenyJson(reason));
  return 0;
};

const postToolUse: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, afterTool(where(payload, io), snakeCall(payload, TOOLS)));
  if (decision.kind === 'context') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: decision.text } }));
  return 0;
};

function stop(phase: 'stop' | 'subagent-stop'): HookHandler {
  return async (ctx, io, payload) => {
    const decision = await decide(ctx, eventInput(where(payload, io), phase, stopFlag(payload) === true));
    if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
    return 0;
  };
}

const postCompact: HookHandler = async (ctx, io, payload) => {
  // SessionStart also fires on startup, resume and clear; the matcher limits it to compact, and this checks again.
  if (payload.source === undefined || payload.source === 'compact') await decide(ctx, eventInput(where(payload, io), 'post-compact'));
  return 0;
};

export function factoryHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: AGENT,
    title: 'Factory Droid',
    file: '.factory/hooks.json',
    container: [],
    layout: 'groups',
    entries: groupEntries(
      AGENT,
      [
        { event: 'PreToolUse', name: 'pre-tool-use', matcher: 'Create|Edit|ApplyPatch', extra: { timeout: 60 } },
        { event: 'PostToolUse', name: 'post-tool-use', extra: { timeout: 60 } },
        { event: 'Stop', name: 'stop', extra: { timeout: 600 } },
        { event: 'SubagentStop', name: 'subagent-stop', extra: { timeout: 600 } },
        { event: 'SessionStart', name: 'post-compact', matcher: 'compact', extra: { timeout: 30 } },
      ],
      cli,
    ),
  };
}

export const factoryAdapter = defineAdapter({
  name: AGENT,
  title: 'Factory Droid',
  markers: ['.factory'],
  handlers: { 'pre-tool-use': preToolUse, 'post-tool-use': postToolUse, stop: stop('stop'), 'subagent-stop': stop('subagent-stop'), 'post-compact': postCompact },
  install: (projectDir, options) => installHooks(projectDir, factoryHooks(anchoredCommand(options.command, 'FACTORY_PROJECT_DIR'))),
  uninstall: (projectDir) => uninstallHooks(projectDir, factoryHooks()),
});

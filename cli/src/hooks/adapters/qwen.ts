// The Qwen Code adapter. Qwen reads the "hooks" key of `.qwen/settings.json` in Claude Code's shape, with timeouts in
// seconds, and sets QWEN_PROJECT_DIR. PreToolUse `additionalContext` without a decision lets the call go through the
// normal permission flow and lands after the tool result, so one PreToolUse hook covers pre-edit and pre-tool. Its
// tools are write_file (`content`), edit (`old_string`, `new_string`, `replace_all`) and run_shell_command. Qwen maps
// every exit code other than 0 and 2 to a non-blocking error, so a missing `buckets` command or a crash fails open.
// Qwen ends a turn after 8 Stop blocks in a row; this adapter blocks once.
import type { Io } from '../../context/index.js';
import type { HookDecision } from '../../contract/index.js';
import { JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler } from '../adapter.js';
import { DEFAULT_COMMAND, groupEntries, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { beforeTool, claudeDenyJson, decide, envPath, eventInput, jsonLine, snakeCall, stopFlag, type ToolKind, type Where, whereOf } from './json-run.js';

const AGENT = 'qwen';

const TOOLS: Record<string, ToolKind> = {
  write_file: 'write',
  edit: 'write',
  notebook_edit: 'write',
  run_shell_command: 'shell',
  Write: 'write',
  Edit: 'write',
  Bash: 'shell',
};

function print(io: Io, decision: HookDecision): void {
  if (decision.kind === 'context') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.text } }));
  else if (decision.kind === 'deny') io.stdout(claudeDenyJson(decision.text));
  else if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
}

const where = (payload: JsonRecord, io: Io): Where => whereOf(payload, io, envPath(io, 'QWEN_PROJECT_DIR'));

const preToolUse: HookHandler = async (ctx, io, payload) => {
  print(io, await decide(ctx, beforeTool(where(payload, io), snakeCall(payload, TOOLS))));
  return 0;
};

function stop(phase: 'stop' | 'subagent-stop'): HookHandler {
  return async (ctx, io, payload) => {
    print(io, await decide(ctx, eventInput(where(payload, io), phase, stopFlag(payload) === true)));
    return 0;
  };
}

const postCompact: HookHandler = async (ctx, io, payload) => {
  await decide(ctx, eventInput(where(payload, io), 'post-compact'));
  return 0;
};

export function qwenHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: AGENT,
    title: 'Qwen Code',
    file: '.qwen/settings.json',
    container: ['hooks'],
    layout: 'groups',
    entries: groupEntries(
      AGENT,
      [
        { event: 'PreToolUse', name: 'pre-tool-use', extra: { timeout: 60 } },
        { event: 'Stop', name: 'stop', extra: { timeout: 600 } },
        { event: 'SubagentStop', name: 'subagent-stop', extra: { timeout: 600 } },
        { event: 'PostCompact', name: 'post-compact', extra: { timeout: 30 } },
      ],
      cli,
    ),
  };
}

export const qwenAdapter = defineAdapter({
  name: AGENT,
  title: 'Qwen Code',
  markers: ['.qwen'],
  handlers: { 'pre-tool-use': preToolUse, stop: stop('stop'), 'subagent-stop': stop('subagent-stop'), 'post-compact': postCompact },
  install: (projectDir, options) => installHooks(projectDir, qwenHooks(options.command)),
  uninstall: (projectDir) => uninstallHooks(projectDir, qwenHooks()),
});

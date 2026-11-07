// The Codex CLI adapter. Codex reads `.codex/hooks.json` in Claude Code's shape and sends Claude-like payloads. Every
// file edit is `apply_patch` with the patch text in `tool_input.command`, so the new text of each file comes from the
// patch applied to the file on disk. PreToolUse `additionalContext` reaches the model without blocking, so one
// PreToolUse hook covers pre-edit and pre-tool. `permissionDecision: "allow"` is not an approval in Codex, but the hook
// never prints it anyway. Codex fails open when a hook exits with another code than 0 or 2, so a missing `buckets`
// command or a crash lets the tool run.
import type { Io } from '../../context/index.js';
import type { HookDecision } from '../../contract/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { DEFAULT_COMMAND, groupEntries, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { beforeTool, decide, eventInput, jsonLine, snakeCall, stopFlag, type ToolKind, whereOf } from './json-run.js';

const AGENT = 'codex';

/** Codex tool names. `Write` and `Edit` are matcher aliases of apply_patch; the other shell names cover older builds. */
const TOOLS: Record<string, ToolKind> = {
  Bash: 'shell',
  shell: 'shell',
  local_shell: 'shell',
  exec_command: 'shell',
  apply_patch: 'patch',
  Write: 'patch',
  Edit: 'patch',
};

function print(io: Io, decision: HookDecision): void {
  if (decision.kind === 'context') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.text } }));
  else if (decision.kind === 'deny') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.text } }));
  else if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
}

const preToolUse: HookHandler = async (ctx, io, payload) => {
  print(io, await decide(ctx, beforeTool(whereOf(payload, io), snakeCall(payload, TOOLS))));
  return 0;
};

function stop(phase: 'stop' | 'subagent-stop'): HookHandler {
  return async (ctx, io, payload) => {
    print(io, await decide(ctx, eventInput(whereOf(payload, io), phase, stopFlag(payload) === true)));
    return 0;
  };
}

const postCompact: HookHandler = async (ctx, io, payload) => {
  await decide(ctx, eventInput(whereOf(payload, io), 'post-compact'));
  return 0;
};

export function codexHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: AGENT,
    title: 'Codex CLI',
    file: '.codex/hooks.json',
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

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const steps = installHooks(projectDir, codexHooks(options.command));
  if (steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'Codex runs project hooks only in a trusted project and after you approve each changed hook: open Codex in this folder, trust it, and approve the slopbuckets hooks in /hooks',
    });
  }
  return steps;
}

export const codexAdapter = defineAdapter({
  name: AGENT,
  title: 'Codex CLI',
  markers: ['.codex'],
  hookFiles: [codexHooks().file],
  handlers: { 'pre-tool-use': preToolUse, stop: stop('stop'), 'subagent-stop': stop('subagent-stop'), 'post-compact': postCompact },
  install,
  uninstall: (projectDir) => uninstallHooks(projectDir, codexHooks()),
});

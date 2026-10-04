// The Codex CLI adapter (hooks stable since 0.124.0). Codex reads `.codex/hooks.json`, which has Claude Code's shape,
// and sends Claude-like payloads. File edits arrive as `apply_patch` with the patch text in `tool_input.command`, so the
// paths come from the patch headers. Codex fails open on a deny without a reason, on `ask` and on other exit codes, so
// every deny here is the JSON form with the full reason and exit 0.
import type { HookAdapter, InstallStep } from '../adapter.js';
import {
  capText,
  claudeDenyJson,
  groupEntries,
  installHookFile,
  jsonLine,
  runHook,
  scopeOf,
  snakeToolCall,
  stopFlag,
  uninstallHookFile,
  type HookFile,
  type RunConfig,
  type ToolKind,
} from './hook-kit.js';

const AGENT = 'codex';
export const CODEX_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop', 'subagent-stop'] as const;

/** Codex tool names. `Write` and `Edit` are matcher aliases of apply_patch; the other shell names cover older builds. */
const TOOLS: Record<string, ToolKind> = {
  Bash: 'shell',
  shell: 'shell',
  local_shell: 'shell',
  exec_command: 'shell',
  apply_patch: 'patch',
  Write: 'write',
  Edit: 'write',
};

/** Codex keeps about 2500 tokens of `additionalContext`. */
const CONTEXT_LIMIT = 8000;

export const codexRun: RunConfig = {
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', 'post-tool-use': 'post-edit', stop: 'stop', 'subagent-stop': 'subagent-stop' },
  scope: (input, io) => scopeOf(input, io),
  call: (input) => snakeToolCall(input, TOOLS),
  deny(io, reason) {
    io.stdout(claudeDenyJson(reason));
    return 0;
  },
  feedback(io, text) {
    // `decision: block` would replace the tool output in Codex, so the report goes in additionalContext.
    const context = capText(text, CONTEXT_LIMIT, 'Run `buckets check --file <path>` on each edited file for the full report.');
    io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
  },
  block(io, text) {
    io.stdout(jsonLine({ decision: 'block', reason: text }));
  },
  stopActive: (input) => stopFlag(input),
};

export const CODEX_HOOKS: HookFile = {
  agent: AGENT,
  title: 'Codex CLI',
  file: '.codex/hooks.json',
  container: ['hooks'],
  layout: 'groups',
  entries: groupEntries(AGENT, [
    { event: 'PreToolUse', name: 'pre-tool-use', matcher: 'Bash|apply_patch|Edit|Write', extra: { timeout: 60 } },
    { event: 'PostToolUse', name: 'post-tool-use', matcher: 'apply_patch|Edit|Write', extra: { timeout: 300 } },
    { event: 'Stop', name: 'stop', extra: { timeout: 600 } },
    { event: 'SubagentStop', name: 'subagent-stop', extra: { timeout: 600 } },
  ]),
};

function install(projectDir: string): InstallStep[] {
  const steps = installHookFile(projectDir, CODEX_HOOKS);
  if (steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'Codex runs project hooks only in a trusted project and after you approve each one: open Codex in this folder, trust it, and approve the slopbuckets hooks in /hooks',
    });
  }
  return steps;
}

export const codexAdapter: HookAdapter = {
  name: AGENT,
  title: 'Codex CLI',
  markers: ['.codex'],
  events: CODEX_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, codexRun),
  install,
  uninstall: (projectDir) => uninstallHookFile(projectDir, CODEX_HOOKS),
};

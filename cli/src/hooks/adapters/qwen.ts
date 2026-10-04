// The Qwen Code adapter. Qwen reads the "hooks" key of `.qwen/settings.json` in Claude Code's shape, with timeouts
// in seconds, and sets QWEN_PROJECT_DIR for every hook. Its tool ids are write_file, edit and run_shell_command (the
// Claude names Write, Edit and Bash work as matcher aliases). A deny writes the JSON and exits with 2. The post-edit
// report goes in `additionalContext`, which Qwen adds after the tool result. Qwen ends a turn after 8 Stop blocks in a
// row; this adapter blocks once anyway.
import type { HookAdapter } from '../adapter.js';
import { claudeLikeRun, groupEntries, installHookFile, runHook, uninstallHookFile, type HookFile, type ToolKind } from './hook-kit.js';

const AGENT = 'qwen';
export const QWEN_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop', 'subagent-stop'] as const;

const TOOLS: Record<string, ToolKind> = {
  write_file: 'write',
  edit: 'write',
  replace: 'write',
  run_shell_command: 'shell',
  Write: 'write',
  Edit: 'write',
  Bash: 'shell',
  read_file: 'other',
  read_many_files: 'other',
  save_memory: 'other',
  todo_write: 'other',
};

export const qwenRun = claudeLikeRun({
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', 'post-tool-use': 'post-edit', stop: 'stop', 'subagent-stop': 'subagent-stop' },
  tools: TOOLS,
  denyExit: 2,
  feedback: 'context',
  envVar: 'QWEN_PROJECT_DIR',
});

export const QWEN_HOOKS: HookFile = {
  agent: AGENT,
  title: 'Qwen Code',
  file: '.qwen/settings.json',
  container: ['hooks'],
  layout: 'groups',
  entries: groupEntries(AGENT, [
    { event: 'PreToolUse', name: 'pre-tool-use', matcher: 'write_file|edit|replace|run_shell_command' },
    { event: 'PostToolUse', name: 'post-tool-use', matcher: 'write_file|edit|replace' },
    { event: 'Stop', name: 'stop' },
    { event: 'SubagentStop', name: 'subagent-stop' },
  ]),
};

export const qwenAdapter: HookAdapter = {
  name: AGENT,
  title: 'Qwen Code',
  markers: ['.qwen'],
  events: QWEN_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, qwenRun),
  install: (projectDir) => installHookFile(projectDir, QWEN_HOOKS),
  uninstall: (projectDir) => uninstallHookFile(projectDir, QWEN_HOOKS),
};

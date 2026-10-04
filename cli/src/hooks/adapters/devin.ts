// The Devin Desktop adapter, for its Devin Local agent (the default agent, formerly Windsurf's). Devin Local reads
// `.devin/hooks.v1.json` and also `.claude/settings.json`, but its tool names are lowercase (read, write, edit, exec),
// so Claude Code matchers never match them. This adapter ships its own file with lowercase matchers. Exit 2 blocks a
// tool call; a deny also writes the Claude-style JSON. Stop supports `decision: block` with `stop_hook_active`. The
// argument names of Devin's tools are not documented, so paths and commands are read under every usual key.
import type { HookAdapter } from '../adapter.js';
import { claudeLikeRun, groupEntries, installHookFile, runHook, uninstallHookFile, workspaceRoot, type HookFile, type ToolKind } from './hook-kit.js';

const AGENT = 'devin';
export const DEVIN_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop'] as const;

const TOOLS: Record<string, ToolKind> = {
  exec: 'shell',
  write: 'write',
  edit: 'write',
  move: 'write',
  delete: 'delete',
  read: 'other',
};

export const devinRun = claudeLikeRun({
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', 'post-tool-use': 'post-edit', stop: 'stop' },
  tools: TOOLS,
  denyExit: 2,
  projectDirOf: workspaceRoot,
});

export const DEVIN_HOOKS: HookFile = {
  agent: AGENT,
  title: 'Devin Desktop',
  file: '.devin/hooks.v1.json',
  container: ['hooks'],
  layout: 'groups',
  entries: groupEntries(AGENT, [
    { event: 'PreToolUse', name: 'pre-tool-use', matcher: 'write|edit|exec|delete|move' },
    { event: 'PostToolUse', name: 'post-tool-use', matcher: 'write|edit' },
    { event: 'Stop', name: 'stop' },
  ]),
};

export const devinAdapter: HookAdapter = {
  name: AGENT,
  title: 'Devin Desktop',
  markers: ['.devin'],
  events: DEVIN_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, devinRun),
  install: (projectDir) => installHookFile(projectDir, DEVIN_HOOKS),
  uninstall: (projectDir) => uninstallHookFile(projectDir, DEVIN_HOOKS),
};

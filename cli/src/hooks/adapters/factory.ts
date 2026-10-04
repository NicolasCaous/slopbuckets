// The Factory Droid adapter (hooks since v0.24.0). Droid reads `.factory/hooks.json`, whose top level holds the events
// in Claude Code's group shape, and sends Claude-like payloads. A hook that answers allow skips Droid's own permission
// prompts, so this adapter only ever denies or says nothing.
import type { HookAdapter } from '../adapter.js';
import { claudeLikeRun, groupEntries, installHookFile, runHook, uninstallHookFile, type HookFile, type ToolKind } from './hook-kit.js';

const AGENT = 'factory';
export const FACTORY_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop', 'subagent-stop'] as const;

const TOOLS: Record<string, ToolKind> = {
  Execute: 'shell',
  Create: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  ApplyPatch: 'patch',
  Read: 'other',
  LS: 'other',
  Grep: 'other',
  Glob: 'other',
};

export const factoryRun = claudeLikeRun({
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', 'post-tool-use': 'post-edit', stop: 'stop', 'subagent-stop': 'subagent-stop' },
  tools: TOOLS,
  denyExit: 0,
  envVar: 'FACTORY_PROJECT_DIR',
});

export const FACTORY_HOOKS: HookFile = {
  agent: AGENT,
  title: 'Factory Droid',
  file: '.factory/hooks.json',
  container: [],
  layout: 'groups',
  entries: groupEntries(AGENT, [
    { event: 'PreToolUse', name: 'pre-tool-use', matcher: 'Execute|Create|Edit|MultiEdit|ApplyPatch' },
    { event: 'PostToolUse', name: 'post-tool-use', matcher: 'Create|Edit|MultiEdit|ApplyPatch' },
    { event: 'Stop', name: 'stop' },
    { event: 'SubagentStop', name: 'subagent-stop' },
  ]),
};

export const factoryAdapter: HookAdapter = {
  name: AGENT,
  title: 'Factory Droid',
  markers: ['.factory'],
  events: FACTORY_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, factoryRun),
  install: (projectDir) => installHookFile(projectDir, FACTORY_HOOKS),
  uninstall: (projectDir) => uninstallHookFile(projectDir, FACTORY_HOOKS),
};

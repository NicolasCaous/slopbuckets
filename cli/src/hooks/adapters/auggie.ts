// The Auggie adapter (Augment's CLI). Auggie reads the "hooks" key of `.augment/settings.json` in Claude Code's shape
// and sends `conversation_id` and `workspace_roots`. Its tools are launch-process, save-file, str-replace-editor and
// remove-files; their argument names are not documented, so paths are read under every usual key. A deny writes the
// JSON and exits with 2. When the stop payload has no `stop_hook_active`, a mark per conversation blocks only once.
import type { HookAdapter } from '../adapter.js';
import { claudeLikeRun, groupEntries, installHookFile, runHook, uninstallHookFile, workspaceRoot, type HookFile, type ToolKind } from './hook-kit.js';

const AGENT = 'auggie';
export const AUGGIE_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop'] as const;

const TOOLS: Record<string, ToolKind> = {
  'launch-process': 'shell',
  'save-file': 'write',
  'str-replace-editor': 'write',
  'remove-files': 'delete',
  view: 'other',
  'read-process': 'other',
  'write-process': 'other',
  'kill-process': 'other',
  'list-processes': 'other',
  'codebase-retrieval': 'other',
  'web-fetch': 'other',
};

export const auggieRun = claudeLikeRun({
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', 'post-tool-use': 'post-edit', stop: 'stop' },
  tools: TOOLS,
  denyExit: 2,
  projectDirOf: workspaceRoot,
});

export const AUGGIE_HOOKS: HookFile = {
  agent: AGENT,
  title: 'Auggie',
  file: '.augment/settings.json',
  container: ['hooks'],
  layout: 'groups',
  entries: groupEntries(AGENT, [
    { event: 'PreToolUse', name: 'pre-tool-use', matcher: 'launch-process|save-file|str-replace-editor|remove-files' },
    { event: 'PostToolUse', name: 'post-tool-use', matcher: 'save-file|str-replace-editor' },
    { event: 'Stop', name: 'stop' },
  ]),
};

export const auggieAdapter: HookAdapter = {
  name: AGENT,
  title: 'Auggie',
  markers: ['.augment'],
  events: AUGGIE_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, auggieRun),
  install: (projectDir) => installHookFile(projectDir, AUGGIE_HOOKS),
  uninstall: (projectDir) => uninstallHookFile(projectDir, AUGGIE_HOOKS),
};

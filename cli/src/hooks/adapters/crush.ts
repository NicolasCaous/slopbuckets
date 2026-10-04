// The Crush adapter. Crush supports one hook event, PreToolUse, configured in the project's `.crush.json` (or
// `crush.json`) under `hooks.PreToolUse`. The payload has `event`, `session_id`, `cwd`, `tool_name` and `tool_input`,
// and Crush sets `CRUSH_PROJECT_DIR`. A deny is `{"decision": "deny", "reason": "..."}` on stdout. The hook never
// answers `allow`, because Crush takes it as approval and skips its permission prompt. Crush runs hooks only for the
// top-level agent, not for sub-agents, and has no hook after an edit or at the end of a turn.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HookAdapter, InstallStep } from '../adapter.js';
import { hookCommand, installHookFile, jsonLine, runHook, scopeOf, snakeToolCall, uninstallHookFile, type HookFile, type RunConfig, type ToolKind } from './hook-kit.js';

const AGENT = 'crush';
const TITLE = 'Crush';
export const CRUSH_EVENTS = ['pre-tool-use'] as const;

/** Crush's tools that run a command or write a file. Each file tool names its target `file_path`. */
const TOOLS: Record<string, ToolKind> = {
  bash: 'shell',
  edit: 'write',
  multiedit: 'write',
  write: 'write',
  download: 'write',
  view: 'other',
  ls: 'other',
  grep: 'other',
  glob: 'other',
  fetch: 'other',
  agentic_fetch: 'other',
  sourcegraph: 'other',
  agent: 'other',
};

export const CRUSH_MATCHER = '^(bash|edit|multiedit|write|download)$';

const config: RunConfig = {
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool' },
  scope: (input, io) => scopeOf(input, io, { envVar: 'CRUSH_PROJECT_DIR' }),
  call: (input) => snakeToolCall(input, TOOLS),
  deny(io, reason) {
    io.stdout(jsonLine({ decision: 'deny', reason }));
    return 0;
  },
  feedback() {},
  block() {},
  stopActive: () => undefined,
};

// ---------------------------------------------------------------------------------------------------------------
// Install

const COMMAND = hookCommand(AGENT, 'pre-tool-use');

function hookFile(file: string): HookFile {
  return {
    agent: AGENT,
    title: TITLE,
    file,
    container: ['hooks'],
    layout: 'flat',
    entries: [{ event: 'PreToolUse', command: COMMAND, entry: { name: 'slopbuckets lock guard', matcher: CRUSH_MATCHER, command: COMMAND, timeout: 60 } }],
  };
}

/** The project config Crush reads: `.crush.json` or `crush.json`, whichever exists, `.crush.json` for a new one. */
export function crushTarget(projectDir: string): string {
  if (existsSync(path.join(projectDir, '.crush.json'))) return '.crush.json';
  if (existsSync(path.join(projectDir, 'crush.json'))) return 'crush.json';
  return '.crush.json';
}

function install(projectDir: string): InstallStep[] {
  return installHookFile(projectDir, hookFile(crushTarget(projectDir)));
}

function uninstall(projectDir: string): InstallStep[] {
  return ['.crush.json', 'crush.json'].flatMap((file) => uninstallHookFile(projectDir, hookFile(file)).filter((step) => step.status !== 'kept'));
}

export const crushAdapter: HookAdapter = {
  name: AGENT,
  title: TITLE,
  markers: ['.crush.json', 'crush.json', '.crush'],
  events: CRUSH_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, config),
  install,
  uninstall,
};

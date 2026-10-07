// The Cursor adapter, for the editor and the cursor-agent CLI (preToolUse since 2.4). Cursor reads
// `.cursor/hooks.json`, where each event holds hooks directly, and runs the commands from the project folder. Shell
// commands come through beforeShellExecution, file writes and deletes through preToolUse. Both answers name the
// permission explicitly, allow included. Cursor's delivery of postToolUse `additional_context` to the model differs
// between versions, so the stop hook (a `followup_message`, limited to one loop) is the fallback.
import { normalizeHarnessPath, str } from '../input.js';
import type { HookAdapter } from '../adapter.js';
import {
  hookCommand,
  installHookFile,
  jsonLine,
  runHook,
  scopeOf,
  snakeToolCall,
  toolCall,
  uninstallHookFile,
  workspaceRoot,
  type HookFile,
  type RunConfig,
  type ToolKind,
} from './hook-kit.js';

const AGENT = 'cursor';
export const CURSOR_EVENTS = ['pre-tool-use', 'before-shell-execution', 'post-tool-use', 'stop', 'subagent-stop'] as const;

/** Cursor tool names. Its Claude compatibility maps Edit and Write to Write; the rest are kept for other versions. */
const TOOLS: Record<string, ToolKind> = {
  Shell: 'shell',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  StrReplace: 'write',
  Delete: 'delete',
  Read: 'other',
  Grep: 'other',
  Glob: 'other',
  LS: 'other',
};

const USER_MESSAGE = 'slopbuckets blocked this call: only a human may change buckets.lock.json or buckets.config.json, or run `buckets refresh`.';

export const cursorRun: RunConfig = {
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', 'before-shell-execution': 'pre-shell', 'post-tool-use': 'post-edit', stop: 'stop', 'subagent-stop': 'subagent-stop' },
  scope: (input, io) => scopeOf(input, io, { projectDir: workspaceRoot(input) }),
  call: (input) => snakeToolCall(input, TOOLS),
  shell(input) {
    const cwd = str(input.cwd);
    return toolCall('shell', { command: input.command, ...(cwd === undefined ? {} : { cwd: normalizeHarnessPath(cwd) }) });
  },
  allow(io) {
    io.stdout(jsonLine({ permission: 'allow' }));
  },
  deny(io, reason) {
    io.stdout(jsonLine({ permission: 'deny', agent_message: reason, user_message: USER_MESSAGE }));
    return 0;
  },
  feedback(io, text) {
    io.stdout(jsonLine({ additional_context: text }));
  },
  block(io, text) {
    io.stdout(jsonLine({ followup_message: text }));
  },
  // The installed stop hook has loop_limit 1; loop_count 0 is the first stop of the turn.
  stopActive: (input) => (typeof input.loop_count === 'number' ? input.loop_count > 0 : undefined),
  stopKey(input, scope, phase) {
    const agent = str(input.subagent_id) ?? str(input.agent_id) ?? str(input.subagent_type) ?? '';
    return `${AGENT}:${phase}:${scope.sessionId ?? scope.cwd}:${phase === 'subagent-stop' ? agent : ''}`;
  },
  // A turn the user stopped by hand ends without a check.
  skipStop: (input) => input.status === 'aborted',
};

const hook = (name: string, extra: Record<string, unknown>) => ({ command: hookCommand(AGENT, name), ...extra });

export const CURSOR_HOOKS: HookFile = {
  agent: AGENT,
  title: 'Cursor',
  file: '.cursor/hooks.json',
  top: { version: 1 },
  container: ['hooks'],
  layout: 'flat',
  // Older versions installed the guards with failClosed: true. slopbuckets hooks fail open in every harness, so install
  // removes it from slopbuckets' own entries.
  staleKeys: ['failClosed'],
  entries: [
    { event: 'preToolUse', entry: hook('pre-tool-use', { matcher: 'Write|Delete', timeout: 30 }) },
    { event: 'beforeShellExecution', entry: hook('before-shell-execution', { timeout: 30 }) },
    { event: 'postToolUse', entry: hook('post-tool-use', { matcher: 'Write', timeout: 300 }) },
    { event: 'stop', entry: hook('stop', { loop_limit: 1, timeout: 600 }) },
    { event: 'subagentStop', entry: hook('subagent-stop', { timeout: 600 }) },
  ].map((item) => ({ ...item, command: item.entry.command })),
};

export const cursorAdapter: HookAdapter = {
  name: AGENT,
  title: 'Cursor',
  markers: ['.cursor', '.cursorrules'],
  events: CURSOR_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, cursorRun),
  install: (projectDir) => installHookFile(projectDir, CURSOR_HOOKS),
  uninstall: (projectDir) => uninstallHookFile(projectDir, CURSOR_HOOKS),
};

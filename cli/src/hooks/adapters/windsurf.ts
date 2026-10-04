// The Windsurf adapter: Cascade, the older agent of Devin Desktop (formerly Windsurf). Cascade reads workspace hooks
// from `.devin/hooks.json`, and from the legacy `.windsurf/hooks.json` only when the first is absent or defines no
// hooks. Two events matter: `pre_write_code` (`tool_info.file_path`) and `pre_run_command` (`tool_info.command_line`
// and `tool_info.cwd`). Exit code 2 blocks the action and Cascade reads stderr. Cascade has no hook after an edit that
// can talk to the model and no hook at the end of a turn.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HookAdapter, InstallStep } from '../adapter.js';
import { JsoncText } from '../../core/jsonc.js';
import { isRecord, normalizeHarnessPath, str, type JsonRecord } from '../input.js';
import { hookCommand, installHookFile, runHook, uninstallHookFile, type HookEntry, type HookFile, type RunConfig, type ToolCall } from './hook-kit.js';

const AGENT = 'windsurf';
const TITLE = 'Windsurf Cascade';
export const WINDSURF_EVENTS = ['pre-write-code', 'pre-run-command'] as const;

export const WINDSURF_FILE = '.devin/hooks.json';
export const WINDSURF_LEGACY_FILE = '.windsurf/hooks.json';

function toolInfo(input: JsonRecord): JsonRecord {
  return isRecord(input.tool_info) ? input.tool_info : {};
}

/** The core action of a Cascade payload, read from `tool_info` whatever the event, so a mixed-up config still guards. */
export function windsurfCall(input: JsonRecord): ToolCall {
  const info = toolInfo(input);
  const command = str(info.command_line);
  if (command !== undefined) {
    const cwd = str(info.cwd);
    return { action: { kind: 'shell', command, ...(cwd === undefined ? {} : { cwd: normalizeHarnessPath(cwd) }) }, edited: [] };
  }
  const file = str(info.file_path);
  if (file !== undefined) return { action: { kind: 'write', paths: [normalizeHarnessPath(file)] }, edited: [] };
  return { action: { kind: 'other' }, edited: [] };
}

const config: RunConfig = {
  agent: AGENT,
  phases: { 'pre-write-code': 'pre-tool', 'pre-run-command': 'pre-shell' },
  // Cascade runs a workspace hook from the root of the repository being worked on.
  scope(input, io) {
    const sessionId = str(input.trajectory_id);
    return { projectDir: io.cwd, cwd: io.cwd, ...(sessionId === undefined ? {} : { sessionId }) };
  },
  call: windsurfCall,
  deny(io, reason) {
    io.stderr(`${reason}\n`);
    return 2;
  },
  feedback() {},
  block() {},
  stopActive: () => undefined,
};

function entry(event: string, name: string): HookEntry {
  const command = hookCommand(AGENT, name);
  // `powershell -Command` exits with 1 on any failure, so the exit code of buckets is passed on by hand.
  return { event, command, entry: { command, powershell: `${command}; exit $LASTEXITCODE`, show_output: true } };
}

function hookFile(file: string): HookFile {
  return {
    agent: AGENT,
    title: TITLE,
    file,
    container: ['hooks'],
    layout: 'flat',
    entries: [entry('pre_write_code', 'pre-write-code'), entry('pre_run_command', 'pre-run-command')],
  };
}

/** True when the file defines at least one hook. A file that cannot be read counts as defining hooks, to stay safe. */
function definesHooks(file: string): boolean {
  try {
    const doc = new JsoncText(readFileSync(file, 'utf8'));
    const hooks = doc.valueOf(doc.root) as unknown;
    if (!isRecord(hooks) || !isRecord(hooks.hooks)) return false;
    return Object.values(hooks.hooks).some((list) => Array.isArray(list) && list.length > 0);
  } catch {
    return true;
  }
}

/**
 * The file Cascade reads for this workspace: `.devin/hooks.json` when it defines hooks, else the legacy
 * `.windsurf/hooks.json` when it exists (writing `.devin/hooks.json` then would hide the user's hooks), else
 * `.devin/hooks.json`.
 */
export function windsurfTarget(projectDir: string): string {
  const primary = path.join(projectDir, WINDSURF_FILE);
  if (existsSync(primary) && definesHooks(primary)) return WINDSURF_FILE;
  if (existsSync(path.join(projectDir, WINDSURF_LEGACY_FILE))) return WINDSURF_LEGACY_FILE;
  return WINDSURF_FILE;
}

function install(projectDir: string): InstallStep[] {
  const target = windsurfTarget(projectDir);
  const steps = installHookFile(projectDir, hookFile(target));
  if (target === WINDSURF_LEGACY_FILE && steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'The hooks went to the legacy .windsurf/hooks.json, which Cascade reads only while .devin/hooks.json defines no hooks. If you move your hooks to .devin/hooks.json, run `buckets init --agent windsurf` again.',
    });
  }
  return steps;
}

function uninstall(projectDir: string): InstallStep[] {
  return [WINDSURF_FILE, WINDSURF_LEGACY_FILE].flatMap((file) => uninstallHookFile(projectDir, hookFile(file)).filter((step) => step.status !== 'kept'));
}

export const windsurfAdapter: HookAdapter = {
  name: AGENT,
  title: TITLE,
  markers: ['.windsurf', '.windsurfrules', WINDSURF_FILE],
  events: WINDSURF_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, config),
  install,
  uninstall,
};

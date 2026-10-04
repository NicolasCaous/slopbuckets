// The Kiro adapter. Kiro CLI 2.x reads hooks from the agent configs in `.kiro/agents/*.json`
// (`"hooks": {"preToolUse": [{"command": "..."}]}`); Kiro CLI 3 and the Kiro IDE also read standalone hook files in
// `.kiro/hooks/<name>.json` (`{"version": "v1", "hooks": [{"trigger": "PreToolUse", "action": {...}}]}`). Only
// PreToolUse can stop anything: exit code 2 blocks the tool call and Kiro hands stderr to the model. postToolUse and
// stop cannot feed a report back or keep the agent working, so slopbuckets installs neither.
//
// Exit code 2 does not block on Windows in kiro-cli (kirodotdev/Kiro#8264). The hook still runs there, but the tool
// call goes on.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HookAdapter, InstallStep } from '../adapter.js';
import { isRecord, normalizeHarnessPath, str, type JsonRecord } from '../input.js';
import { hookCommand, installHookFile, isAgentCommand, kindOf, pathsIn, runHook, scopeOf, toolCall, uninstallHookFile, type HookFile, type RunConfig, type ToolCall, type ToolKind } from './hook-kit.js';

const AGENT = 'kiro';
const TITLE = 'Kiro';
export const KIRO_EVENTS = ['pre-tool-use'] as const;

/** Kiro tool names across runtime generations: canonical names, their aliases and the Windows shell. */
const TOOLS: Record<string, ToolKind> = {
  fs_write: 'write',
  write: 'write',
  str_replace: 'write',
  fs_append: 'write',
  delete_file: 'delete',
  execute_bash: 'shell',
  execute_pwsh: 'shell',
  execute_cmd: 'shell',
  shell: 'shell',
  fs_read: 'other',
  read: 'other',
};

/** The tool call of a Kiro payload. Paths may also sit in `operations[].path`. */
export function kiroCall(input: JsonRecord): ToolCall {
  const args = isRecord(input.tool_input) ? input.tool_input : {};
  const call = toolCall(kindOf(str(input.tool_name) ?? '', TOOLS), args, input.tool_input);
  if (call.action.kind !== 'write' || !Array.isArray(args.operations)) return call;
  const extra = args.operations.filter(isRecord).flatMap((operation) => pathsIn(operation));
  const paths = [...new Set([...call.action.paths, ...extra.map(normalizeHarnessPath)])];
  return { action: { kind: 'write', paths }, edited: call.edited };
}

const config: RunConfig = {
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool' },
  scope: (input, io) => scopeOf(input, io),
  call: kiroCall,
  deny(io, reason) {
    io.stderr(`${reason}\n`);
    return 2;
  },
  feedback() {},
  block() {},
  stopActive: () => undefined,
};

const COMMAND = hookCommand(AGENT, 'pre-tool-use');

// ---------------------------------------------------------------------------------------------------------------
// Install

/** The standalone hook file, read by Kiro CLI 3 and the Kiro IDE. It belongs to slopbuckets. */
export const KIRO_HOOK_FILE = '.kiro/hooks/slopbuckets.json';
export const KIRO_AGENTS_DIR = '.kiro/agents';

/** No matcher: Kiro names its write and shell tools differently across versions, so the hook sees every tool. */
export const KIRO_V1_HOOK = {
  name: 'slopbuckets-lock-guard',
  trigger: 'PreToolUse',
  action: { type: 'command', command: COMMAND },
  timeout: 60,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOurV1Hook(hook: unknown): boolean {
  return isRecord(hook) && isRecord(hook.action) && isAgentCommand(AGENT, hook.action.command);
}

function installV1(projectDir: string): InstallStep {
  const file = path.join(projectDir, KIRO_HOOK_FILE);
  try {
    let value: JsonRecord = { version: 'v1', hooks: [] };
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed.hooks)) throw new Error(`${KIRO_HOOK_FILE} must hold an object with a "hooks" array`);
      if (parsed.hooks.some(isOurV1Hook)) return { status: 'kept', text: `The Kiro hook is already in ${KIRO_HOOK_FILE}` };
      value = parsed;
    }
    (value.hooks as unknown[]).push(KIRO_V1_HOOK);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return { status: 'done', text: `Installed the Kiro hook in ${KIRO_HOOK_FILE} (PreToolUse, for Kiro CLI 3 and the Kiro IDE)` };
  } catch (error) {
    return { status: 'failed', text: `Could not install the Kiro hook: ${message(error)}. Fix ${KIRO_HOOK_FILE} and run \`buckets init\` again.` };
  }
}

function uninstallV1(projectDir: string): InstallStep[] {
  const file = path.join(projectDir, KIRO_HOOK_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.hooks) || !parsed.hooks.some(isOurV1Hook)) return [];
    const rest = parsed.hooks.filter((hook) => !isOurV1Hook(hook));
    if (rest.length === 0) {
      rmSync(file, { force: true });
      const dir = path.dirname(file);
      if (readdirSync(dir).length === 0) rmdirSync(dir);
      return [{ status: 'done', text: `Removed ${KIRO_HOOK_FILE}, which held only the slopbuckets hook` }];
    }
    writeFileSync(file, `${JSON.stringify({ ...parsed, hooks: rest }, null, 2)}\n`, 'utf8');
    return [{ status: 'done', text: `Removed the slopbuckets hook from ${KIRO_HOOK_FILE}` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove the Kiro hook: ${message(error)}. Fix ${KIRO_HOOK_FILE} and try again.` }];
  }
}

/** The agent configs of the project, relative to it with forward slashes. */
function agentFiles(projectDir: string): string[] {
  try {
    return readdirSync(path.join(projectDir, KIRO_AGENTS_DIR), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => `${KIRO_AGENTS_DIR}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

function agentHookFile(file: string): HookFile {
  return {
    agent: AGENT,
    title: TITLE,
    file,
    container: ['hooks'],
    layout: 'flat',
    entries: [{ event: 'preToolUse', command: COMMAND, entry: { command: COMMAND, timeout_ms: 60_000 } }],
  };
}

function install(projectDir: string): InstallStep[] {
  const steps: InstallStep[] = [installV1(projectDir)];
  const agents = agentFiles(projectDir);
  for (const file of agents) steps.push(...installHookFile(projectDir, agentHookFile(file)));
  if (agents.length === 0) {
    steps.push({
      status: 'todo',
      text: `Kiro CLI 2.x reads hooks only from agent configs, and ${KIRO_AGENTS_DIR}/ has none. If you use Kiro CLI 2.x, add {"command": "${COMMAND}"} to "hooks.preToolUse" of the agent you run, or run \`buckets init --agent kiro\` again after you create it.`,
    });
  }
  if (process.platform === 'win32') {
    steps.push({
      status: 'todo',
      text: 'kiro-cli on Windows does not block a tool call when a hook exits with code 2 (kirodotdev/Kiro#8264), so the lock guard only warns there. Rely on `buckets init --git-hook` and CI.',
    });
  }
  return steps;
}

function uninstall(projectDir: string): InstallStep[] {
  const steps = uninstallV1(projectDir);
  for (const file of agentFiles(projectDir)) steps.push(...uninstallHookFile(projectDir, agentHookFile(file)).filter((step) => step.status !== 'kept'));
  return steps;
}

export const kiroAdapter: HookAdapter = {
  name: AGENT,
  title: TITLE,
  markers: ['.kiro'],
  events: KIRO_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, config),
  install,
  uninstall,
};

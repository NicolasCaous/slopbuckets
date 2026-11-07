// The GitHub Copilot adapter, for Copilot CLI and the Copilot cloud agent, which read `.github/hooks/*.json`. The
// payload is camelCase and `toolArgs` is a JSON string, or the bare patch text for apply_patch. Since CLI 1.0.24 a
// preToolUse hook can answer `additionalContext` without a decision, so one preToolUse hook covers pre-edit and
// pre-tool. `permissionDecision: "allow"` skips the approval prompt since 1.0.18, so it is never printed.
//
// A command preToolUse hook that crashes or exits with another code than 0 denies the call (1.0.57), and a shell
// without the `buckets` command exits with 127. So each command runs inside a guard that skips it when the CLI is
// missing, the deny is JSON with exit 0, and every error path exits with 0. Timeouts fail open.
import type { Io } from '../../context/index.js';
import type { HookDecision } from '../../contract/index.js';
import { parseJson, type JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { decodeArgs, str } from '../input.js';
import { DEFAULT_COMMAND, failOpenPowerShell, failOpenSh, hookCommand, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { beforeTool, decide, decideStopByMark, eventInput, jsonLine, kindOf, stopFlag, type ToolCall, type ToolKind, whereOf } from './json-run.js';

const AGENT = 'copilot';

const TOOLS: Record<string, ToolKind> = {
  bash: 'shell',
  powershell: 'shell',
  create: 'write',
  edit: 'write',
  str_replace_editor: 'write',
  apply_patch: 'patch',
  view: 'other',
};

/** `toolArgs` as an object, plus the raw text when it is a bare string (apply_patch sends the patch itself). */
function copilotCall(payload: JsonRecord): ToolCall {
  const value = payload.toolArgs ?? payload.tool_input;
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      const decoded: unknown = parseJson(value);
      if (typeof decoded === 'string') raw = decoded;
    } catch {
      // Not JSON: the string is the argument itself.
    }
  }
  const name = str(payload.toolName) ?? str(payload.tool_name) ?? '';
  return { name, kind: kindOf(name, TOOLS), args: decodeArgs(value), raw };
}

function print(io: Io, decision: HookDecision): void {
  if (decision.kind === 'context') io.stdout(jsonLine({ additionalContext: decision.text }));
  else if (decision.kind === 'deny') io.stdout(jsonLine({ permissionDecision: 'deny', permissionDecisionReason: decision.text }));
  else if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
}

const preToolUse: HookHandler = async (ctx, io, payload) => {
  print(io, await decide(ctx, beforeTool(whereOf(payload, io), copilotCall(payload))));
  return 0;
};

const agentStop: HookHandler = async (ctx, io, payload) => {
  print(io, await decide(ctx, eventInput(whereOf(payload, io), 'stop', stopFlag(payload) === true)));
  return 0;
};

const subagentStop: HookHandler = async (ctx, io, payload) => {
  const where = whereOf(payload, io);
  // subagentStop has no stop_hook_active, so a mark per subagent blocks only once.
  const key = `${AGENT}:subagent-stop:${where.sessionId ?? where.cwd}:${where.agentId ?? ''}`;
  print(io, await decideStopByMark(ctx, eventInput(where, 'subagent-stop'), key));
  return 0;
};

export function copilotHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  const hook = (name: string, extra: Record<string, unknown>): { command: string; entry: Record<string, unknown> } => {
    const command = hookCommand(AGENT, name, cli);
    const bash = failOpenSh(command, cli);
    return { command: bash, entry: { type: 'command', bash, powershell: failOpenPowerShell(command, cli), ...extra } };
  };
  return {
    agent: AGENT,
    title: 'GitHub Copilot',
    file: '.github/hooks/slopbuckets.json',
    top: { version: 1 },
    container: ['hooks'],
    layout: 'flat',
    owned: true,
    entries: [
      { event: 'preToolUse', ...hook('pre-tool-use', { timeoutSec: 60 }) },
      { event: 'agentStop', ...hook('agent-stop', { timeoutSec: 600 }) },
      { event: 'subagentStop', ...hook('subagent-stop', { timeoutSec: 600 }) },
    ],
  };
}

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const steps = installHooks(projectDir, copilotHooks(options.command));
  if (steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'The Copilot cloud agent reads hooks from the cloned repository and needs the buckets CLI: commit .github/hooks/slopbuckets.json and install the CLI in .github/workflows/copilot-setup-steps.yml',
    });
  }
  return steps;
}

export const copilotAdapter = defineAdapter({
  name: AGENT,
  title: 'GitHub Copilot',
  markers: ['.github/hooks', '.github/copilot-instructions.md', '.github/instructions', '.github/skills'],
  // Copilot reads every JSON file of .github/hooks/.
  hookFiles: ['.github/hooks/'],
  handlers: { 'pre-tool-use': preToolUse, 'agent-stop': agentStop, 'subagent-stop': subagentStop },
  install,
  uninstall: (projectDir) => uninstallHooks(projectDir, copilotHooks()),
});

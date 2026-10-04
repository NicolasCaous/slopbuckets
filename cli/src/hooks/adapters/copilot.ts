// The GitHub Copilot adapter, for Copilot CLI, the Copilot cloud agent and the Copilot harness of VS Code, which all
// read `.github/hooks/*.json` (the cloud agent only from the default branch). The payload is camelCase and `toolArgs`
// is usually a JSON string, or the bare patch text for apply_patch. Each hook has a bash and a powershell command.
// Copilot treats a hook that times out as allow, so the guard does no checking work and its timeout stays short. But a
// preToolUse command hook that exits with an error denies the call, and a shell without the `buckets` command exits
// with 127, so each command runs inside a guard that skips it when the CLI is missing. That keeps the hooks fail-open.
import { parseJson } from '../../core/json.js';
import type { HookAdapter, InstallStep } from '../adapter.js';
import { decodeArgs, str, type JsonRecord } from '../input.js';
import {
  capText,
  failOpenPowerShell,
  failOpenSh,
  hookCommand,
  installHookFile,
  jsonLine,
  kindOf,
  runHook,
  scopeOf,
  stopFlag,
  toolCall,
  uninstallHookFile,
  type HookFile,
  type RunConfig,
  type ToolCall,
  type ToolKind,
} from './hook-kit.js';

const AGENT = 'copilot';
export const COPILOT_EVENTS = ['pre-tool-use', 'post-tool-use', 'agent-stop', 'subagent-stop'] as const;

const CONTEXT_LIMIT = 8000;

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
function copilotCall(input: JsonRecord): ToolCall {
  const raw = input.toolArgs ?? input.tool_input;
  let text: string | undefined;
  if (typeof raw === 'string') {
    text = raw;
    try {
      const decoded: unknown = parseJson(raw);
      if (typeof decoded === 'string') text = decoded;
    } catch {
      // Not JSON: the string is the argument itself.
    }
  }
  return toolCall(kindOf(str(input.toolName) ?? str(input.tool_name) ?? '', TOOLS), decodeArgs(raw), text);
}

export const copilotRun: RunConfig = {
  agent: AGENT,
  phases: { 'pre-tool-use': 'pre-tool', 'post-tool-use': 'post-edit', 'agent-stop': 'stop', 'subagent-stop': 'subagent-stop' },
  scope: (input, io) => scopeOf(input, io),
  call: copilotCall,
  deny(io, reason) {
    io.stdout(jsonLine({ permissionDecision: 'deny', permissionDecisionReason: reason }));
    return 0;
  },
  feedback(io, text) {
    // Copilot caps the joined additionalContext of all hooks at 10 KB.
    io.stdout(jsonLine({ additionalContext: capText(text, CONTEXT_LIMIT, 'Run `buckets check --file <path>` on the edited file for the full report.') }));
  },
  block(io, text) {
    io.stdout(jsonLine({ decision: 'block', reason: text }));
  },
  // agentStop has stop_hook_active; subagentStop has none, so the mark of the subagent decides.
  stopActive: (input) => stopFlag(input),
  stopKey(input, scope, phase) {
    const agent = str(input.agentId) ?? str(input.agent_id) ?? str(input.subagentId) ?? str(input.agentName) ?? '';
    return `${AGENT}:${phase}:${scope.sessionId ?? scope.cwd}:${phase === 'subagent-stop' ? agent : ''}`;
  },
};

function hook(name: string, extra: Record<string, unknown>): { command: string; entry: Record<string, unknown> } {
  const command = hookCommand(AGENT, name);
  const bash = failOpenSh(command);
  return { command: bash, entry: { type: 'command', bash, powershell: failOpenPowerShell(command), ...extra } };
}

export const COPILOT_HOOKS: HookFile = {
  agent: AGENT,
  title: 'GitHub Copilot',
  file: '.github/hooks/slopbuckets.json',
  top: { version: 1 },
  container: ['hooks'],
  layout: 'flat',
  owned: true,
  entries: [
    { event: 'preToolUse', ...hook('pre-tool-use', { timeoutSec: 30, matcher: 'edit|create|apply_patch|str_replace_editor|bash|powershell' }) },
    { event: 'postToolUse', ...hook('post-tool-use', { timeoutSec: 300, matcher: 'edit|create|apply_patch|str_replace_editor' }) },
    { event: 'agentStop', ...hook('agent-stop', { timeoutSec: 600 }) },
    { event: 'subagentStop', ...hook('subagent-stop', { timeoutSec: 600 }) },
  ],
};

function install(projectDir: string): InstallStep[] {
  const steps = installHookFile(projectDir, COPILOT_HOOKS);
  if (steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'The Copilot cloud agent reads hooks from the default branch and needs the buckets CLI: commit .github/hooks/slopbuckets.json and install the CLI in .github/workflows/copilot-setup-steps.yml',
    });
  }
  return steps;
}

export const copilotAdapter: HookAdapter = {
  name: AGENT,
  title: 'GitHub Copilot',
  markers: ['.github/hooks', '.github/copilot-instructions.md', '.github/instructions', '.github/skills'],
  events: COPILOT_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, copilotRun),
  install,
  uninstall: (projectDir) => uninstallHookFile(projectDir, COPILOT_HOOKS),
};

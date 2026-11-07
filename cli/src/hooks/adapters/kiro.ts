// The Kiro adapter. Kiro CLI 3 and the Kiro IDE read standalone hook files in `.kiro/hooks/<name>.json`
// (`{"version": "v1", "hooks": [{"trigger": "PreToolUse", "action": {...}}]}`); Kiro CLI 2.x reads hooks from the agent
// configs in `.kiro/agents/*.json` (`"hooks": {"preToolUse": [{"command": "..."}]}`).
//
// PreToolUse runs for every tool. Exit code 2 refuses the call and Kiro hands stderr to the model, so the pre-edit
// interrupt (config-invalid) uses it. The CLI ignores what a tool hook prints on exit 0; the IDE docs say it adds that
// stdout to the context, so the pending list goes to stdout and reaches the model where Kiro reads it. Exit code 2 does
// not block on Windows (kirodotdev/Kiro#8264): the hook runs, but the call goes on.
//
// Stop (CLI 3): `{"decision": "block", "reason": "..."}` with exit 0 starts another turn. The payload has no
// `stop_hook_active`, so a mark per session lets the hook block only once in a row. The hook never exits with 1 at a
// stop, because Kiro reads that as "continue". It goes only in the standalone file: a second copy in an agent config
// would run twice per stop and the two copies would undo each other's mark.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../context/index.js';
import type { HookEdit, HookInput } from '../../contract/index.js';
import { isRecord, type JsonRecord } from '../../files/index.js';
import { message } from '../../output/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { replaceEdit } from '../edit-text.js';
import { normalizeHarnessPath, str } from '../input.js';
import { removeProjectFile, writeProjectFile } from '../project-file.js';
import { DEFAULT_COMMAND, hookCommand, installHooks, isAgentCommand, type JsonHookFile, uninstallHooks } from './json-install.js';
import { decide, decideStopByMark, eventInput, jsonLine, kindOf, pathsIn, toolInput, type ToolKind } from './json-run.js';

const AGENT = 'kiro';
const TITLE = 'Kiro';

/** Kiro tool IDs: CLI 3 first, then the CLI 2.x names and aliases. */
const TOOLS: Record<string, ToolKind> = {
  fs_write: 'write',
  fs_append: 'write',
  str_replace: 'write',
  delete_file: 'delete',
  execute_bash: 'shell',
  execute_pwsh: 'shell',
  read_file: 'other',
  list_directory: 'other',
  file_search: 'other',
  grep_search: 'other',
  web_fetch: 'other',
  remote_web_search: 'other',
  invoke_sub_agent: 'other',
  write: 'write',
  execute_cmd: 'shell',
  shell: 'shell',
  fs_read: 'other',
  read: 'other',
};

/**
 * The edit of the one file a write call changes, with its new text when the input gives it: `fs_write` `create` with
 * `file_text`, or a replacement with `old_str` and `new_str` (`oldStr` and `newStr` in the IDE). The CLI 3 field names
 * are inferred from its predecessor, the Amazon Q Developer CLI.
 */
function writtenEdit(args: JsonRecord, file: string, root: string): HookEdit {
  const command = str(args.command);
  if (command === 'create' && typeof args.file_text === 'string') return { path: file, content: args.file_text };
  const oldText = args.old_str ?? args.oldStr;
  const newText = args.new_str ?? args.newStr;
  if ((command === undefined || command === 'str_replace') && typeof oldText === 'string' && typeof newText === 'string') {
    return replaceEdit(root, file, [{ old: oldText, new: newText }], { emptyOld: 'new-file' });
  }
  return { path: file };
}

/** The files a Kiro tool call changes. Paths may also sit in `operations[].path` (CLI 2.x). */
export function kiroEdits(tool: string, args: JsonRecord, cwd: string): HookEdit[] {
  const kind = kindOf(tool, TOOLS);
  if (kind !== 'write' && kind !== 'delete') return [];
  const operations = Array.isArray(args.operations) ? args.operations.filter(isRecord) : [];
  const files = [...new Set([...pathsIn(args), ...operations.flatMap(pathsIn)])].map((file) => path.resolve(cwd, file));
  if (kind === 'delete') return files.map((file) => ({ path: file, content: null }));
  return files.length === 1 ? [writtenEdit(args, files[0]!, cwd)] : files.map((file) => ({ path: file }));
}

/** The core input of a Kiro payload (`hook_event_name`, `cwd`, `session_id`, `tool_name`, `tool_input`). */
export function kiroInput(payload: JsonRecord, io: Io, event: string): HookInput {
  const cwdValue = str(payload.cwd);
  const cwd = path.resolve(cwdValue === undefined ? io.cwd : normalizeHarnessPath(cwdValue));
  const where = { sessionId: str(payload.session_id) ?? null, agentId: null, cwd, root: cwd };
  if (event === 'stop') return eventInput(where, 'stop');
  const tool = str(payload.tool_name) ?? '';
  return toolInput(where, tool, kiroEdits(tool, isRecord(payload.tool_input) ? payload.tool_input : {}, cwd), kindOf(tool, TOOLS) === 'shell');
}

// A crash exits with 0 and prints nothing, which lets the tool run and the agent stop.
const preToolUse: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, kiroInput(payload, io, 'pre-tool-use'));
  if (decision.kind === 'deny') {
    io.stderr(`${decision.text}\n`);
    return 2;
  }
  if (decision.kind === 'context') io.stdout(`${decision.text}\n`);
  return 0;
};

const stop: HookHandler = async (ctx, io, payload) => {
  const input = kiroInput(payload, io, 'stop');
  const decision = await decideStopByMark(ctx, input, `${AGENT}:stop:${input.sessionId ?? input.cwd}`);
  if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'block', reason: decision.text }));
  return 0;
};

// ---------------------------------------------------------------------------------------------------------------
// Install

/** The standalone hook file, read by Kiro CLI 3 and the Kiro IDE. It belongs to slopbuckets. */
export const KIRO_HOOK_FILE = '.kiro/hooks/slopbuckets.json';
export const KIRO_AGENTS_DIR = '.kiro/agents';

/** No matcher, so the pending list shows before any tool and shell calls mark the session. */
export function kiroV1Hooks(cli: string = DEFAULT_COMMAND) {
  return [
    { name: 'slopbuckets', trigger: 'PreToolUse', action: { type: 'command', command: hookCommand(AGENT, 'pre-tool-use', cli) }, timeout: 60 },
    { name: 'slopbuckets-stop', trigger: 'Stop', action: { type: 'command', command: hookCommand(AGENT, 'stop', cli) }, timeout: 120 },
  ];
}
function commandOfV1(hook: unknown): unknown {
  return isRecord(hook) && isRecord(hook.action) ? hook.action.command : undefined;
}

function installV1(projectDir: string, cli: string | undefined): InstallStep {
  const file = path.join(projectDir, KIRO_HOOK_FILE);
  const wanted = kiroV1Hooks(cli);
  try {
    let value: JsonRecord = { version: 'v1', hooks: [] };
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed.hooks)) throw new Error(`${KIRO_HOOK_FILE} must hold an object with a "hooks" array`);
      value = parsed;
    }
    // A hook of an older command, such as `buckets` before a local install, is replaced.
    const hooks = (value.hooks as unknown[]).filter((hook) => !isAgentCommand(AGENT, commandOfV1(hook)) || wanted.some((ours) => commandOfV1(hook) === ours.action.command));
    const missing = wanted.filter((ours) => !hooks.some((hook) => commandOfV1(hook) === ours.action.command));
    if (missing.length === 0 && hooks.length === (value.hooks as unknown[]).length) return { status: 'kept', text: `The Kiro hooks are already in ${KIRO_HOOK_FILE}` };
    hooks.push(...missing);
    value.hooks = hooks;
    writeProjectFile(projectDir, KIRO_HOOK_FILE, `${JSON.stringify(value, null, 2)}\n`);
    return { status: 'done', text: `Installed the Kiro hooks in ${KIRO_HOOK_FILE} (${missing.map((hook) => hook.trigger).join(', ')}, for Kiro CLI 3 and the Kiro IDE)` };
  } catch (error) {
    return { status: 'failed', text: `Could not install the Kiro hooks: ${message(error)}. Fix ${KIRO_HOOK_FILE} and run \`buckets init\` again.` };
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

/** Kiro CLI 2.x cannot block a stop, so an agent config gets only preToolUse. */
function agentHookFile(file: string, cli: string = DEFAULT_COMMAND): JsonHookFile {
  const PRE_COMMAND = hookCommand(AGENT, 'pre-tool-use', cli);
  return {
    agent: AGENT,
    title: TITLE,
    file,
    container: ['hooks'],
    layout: 'flat',
    entries: [{ event: 'preToolUse', command: PRE_COMMAND, entry: { command: PRE_COMMAND, timeout_ms: 60_000 } }],
  };
}

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const steps: InstallStep[] = [installV1(projectDir, options.command)];
  const agents = agentFiles(projectDir);
  for (const file of agents) steps.push(...installHooks(projectDir, agentHookFile(file, options.command)));
  if (agents.length === 0) {
    steps.push({
      status: 'todo',
      text: `Kiro CLI 2.x reads hooks only from agent configs, and ${KIRO_AGENTS_DIR}/ has none. If you use Kiro CLI 2.x, add {"command": "${hookCommand(AGENT, 'pre-tool-use', options.command)}"} to "hooks.preToolUse" of the agent you run, or run \`buckets init --agent kiro\` again after you create it.`,
    });
  }
  steps.push({
    status: 'todo',
    text: 'Only Kiro CLI 3 lets the stop hook keep the agent working. In the Kiro IDE and Kiro CLI 2.x the agent relies on the AGENTS.md instruction to run `buckets check` before it finishes; run `buckets init --git-hook` to check every commit too.',
  });
  if (process.platform === 'win32') {
    steps.push({
      status: 'todo',
      text: 'kiro-cli on Windows does not block a tool call when a hook exits with code 2 (kirodotdev/Kiro#8264), so an edit that breaks buckets.config.json goes through there. The stop hook and `buckets init --git-hook` still catch it.',
    });
  }
  return steps;
}

function uninstallV1(projectDir: string): InstallStep[] {
  const file = path.join(projectDir, KIRO_HOOK_FILE);
  if (!existsSync(file)) return [];
  const ours = (hook: unknown): boolean => isAgentCommand(AGENT, commandOfV1(hook));
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.hooks) || !parsed.hooks.some(ours)) return [];
    const rest = parsed.hooks.filter((hook) => !ours(hook));
    if (rest.length === 0) {
      removeProjectFile(projectDir, KIRO_HOOK_FILE);
      return [{ status: 'done', text: `Removed ${KIRO_HOOK_FILE}, which held only the slopbuckets hooks` }];
    }
    writeProjectFile(projectDir, KIRO_HOOK_FILE, `${JSON.stringify({ ...parsed, hooks: rest }, null, 2)}\n`);
    return [{ status: 'done', text: `Removed the slopbuckets hooks from ${KIRO_HOOK_FILE}` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove the Kiro hooks: ${message(error)}. Fix ${KIRO_HOOK_FILE} and run \`buckets uninstall\` again.` }];
  }
}

export const kiroAdapter = defineAdapter({
  name: AGENT,
  title: TITLE,
  markers: ['.kiro'],
  hookFiles: [KIRO_HOOK_FILE, `${KIRO_AGENTS_DIR}/`],
  handlers: { 'pre-tool-use': preToolUse, stop },
  install,
  uninstall: (projectDir) => [...uninstallV1(projectDir), ...agentFiles(projectDir).flatMap((file) => uninstallHooks(projectDir, agentHookFile(file)))],
});

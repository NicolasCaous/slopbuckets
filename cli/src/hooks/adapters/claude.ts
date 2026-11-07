// The Claude Code adapter. Claude Code runs `buckets hook <event>` (the entry without `--agent`) with its JSON on stdin.
// Every path exits with 0, so a hook never breaks the session; the decision travels in the JSON written to stdout.
// PreToolUse never prints `permissionDecision: "allow"`, because that would skip the user's permission prompt.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../context/index.js';
import type { HookDecision, HookEdit, HookInput } from '../../contract/index.js';
import { isRecord, type JsonRecord } from '../../files/index.js';
import { message } from '../../output/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { replaceEdit } from '../edit-text.js';
import { str } from '../input.js';
import { removeProjectFile, writeProjectFile } from '../project-file.js';
import { anchoredCommand, DEFAULT_COMMAND, installHooks, isAgentCommand, uninstallHooks, type HookEntry, type JsonHookFile } from './json-install.js';
import { decide, envPath, eventInput, jsonLine, toolInput, whereOf } from './json-run.js';

export const HOOK_EVENTS = ['pre-tool-use', 'stop', 'subagent-stop', 'post-compact'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * The file a Claude Code edit tool changes, with its new content when it can be known: Write's `content`, or Edit's
 * `old_string` replaced by `new_string` (every occurrence with `replace_all`, else exactly one) in the text on disk. An
 * Edit that cannot apply, a NotebookEdit and a MultiEdit have unknown content, which the core treats as a pre-tool call
 * that changes files. Empty for any other tool.
 */
export function claudeEdits(tool: string, args: JsonRecord, cwd: string, root: string): HookEdit[] {
  if (!EDIT_TOOLS.has(tool)) return [];
  const name = str(args.file_path) ?? str(args.notebook_path);
  if (name === undefined) return [];
  const file = path.resolve(cwd, name);
  if (tool === 'Write' && typeof args.content === 'string') return [{ path: file, content: args.content }];
  if (tool === 'Edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    return [replaceEdit(root, file, [{ old: args.old_string, new: args.new_string, all: args.replace_all === true }], { unique: true, emptyOld: 'new-file' })];
  }
  return [{ path: file }];
}

/** The core input of a Claude Code hook payload. The root is CLAUDE_PROJECT_DIR, else the payload cwd, else the process cwd. */
export function claudeInput(event: HookEvent, payload: JsonRecord, io: Io): HookInput {
  const found = whereOf(payload, io, envPath(io, 'CLAUDE_PROJECT_DIR'));
  const where = { ...found, cwd: path.resolve(found.cwd), root: path.resolve(found.root) };
  if (event !== 'pre-tool-use') return eventInput(where, event, payload.stop_hook_active === true);
  const tool = str(payload.tool_name) ?? '';
  const args = isRecord(payload.tool_input) ? payload.tool_input : {};
  return toolInput(where, tool, claudeEdits(tool, args, where.cwd, where.root), SHELL_TOOLS.has(tool));
}

/** The stdout line of a decision, or an empty string for silent. */
export function claudeOutput(decision: HookDecision): string {
  switch (decision.kind) {
    case 'silent':
      return '';
    case 'context':
      return jsonLine({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.text } });
    case 'deny':
      return jsonLine({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.text } });
    case 'block':
      return jsonLine({ decision: 'block', reason: decision.text });
    case 'note':
      return jsonLine({ systemMessage: decision.text });
  }
}

/**
 * The harness that sent a payload when it is not Claude Code, else undefined. Cursor, GitHub Copilot and Devin also run
 * the hooks of .claude/settings.json, next to their own slopbuckets hooks, so without this check a stop would block
 * twice and a payload of another shape would be read as Claude Code's (docs/guide/agents/index.md, "Several agents
 * in one project").
 *
 * - Cursor sends `cursor_version`, `conversation_id` and `generation_id` with every event.
 * - Devin sets DEVIN_PROJECT_DIR for every hook, and adds `tool_provenance` to PreToolUse.
 * - A camelCase `hook_event_name` (`preToolUse`) is never Claude Code's, which spells events in PascalCase.
 *
 * GitHub Copilot runs a PascalCase entry of .claude/settings.json with a snake_case payload in Claude Code's shape and
 * with Claude Code's tool names. No documented field or variable tells it apart, so that hook runs there too.
 */
export function foreignHarness(input: JsonRecord, env: Io['env']): string | undefined {
  if ('cursor_version' in input || ('conversation_id' in input && 'generation_id' in input)) return 'Cursor';
  if (str(env.DEVIN_PROJECT_DIR) !== undefined || 'tool_provenance' in input) return 'Devin';
  if (/^[a-z]/.test(str(input.hook_event_name) ?? '')) return 'another agent';
  return undefined;
}

function handler(event: HookEvent): HookHandler {
  return async (ctx, io, payload) => {
    // That harness has its own slopbuckets hooks, so the Claude Code one stays out of the way.
    if (foreignHarness(payload, io.env) === undefined) io.stdout(claudeOutput(await decide(ctx, claudeInput(event, payload, io))));
    return 0;
  };
}

/**
 * One PreToolUse hook for every tool: edits become pre-edit, the rest pre-tool. `onFailure: "continue"` keeps a
 * missing or crashing CLI from blocking every tool call on Windows without Git Bash (Claude Code 2.1.299 and later).
 */
function entry(cli: string, event: string, name: string, matcher?: string, extra: JsonRecord = {}): HookEntry {
  const command = `${cli} hook ${name}`;
  return { event, command, entry: { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command, ...extra }] } };
}

/** The hooks of .claude/settings.json, run with `cli`. */
export function claudeHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: 'claude',
    title: 'Claude Code',
    file: '.claude/settings.json',
    container: ['hooks'],
    layout: 'groups',
    entries: [
      entry(cli, 'PreToolUse', 'pre-tool-use', '*', { onFailure: 'continue' }),
      entry(cli, 'Stop', 'stop'),
      entry(cli, 'SubagentStop', 'subagent-stop'),
      entry(cli, 'PostCompact', 'post-compact'),
    ],
    // `<cli> hook <event>`, or the same with `--agent claude`.
    ours: (command) => isAgentCommand(null, command),
  };
}

const SKILL = '.claude/skills/slopbuckets/SKILL.md';

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  // Claude Code runs hooks with bash, Git Bash on Windows, in the session's current folder.
  const steps = installHooks(projectDir, claudeHooks(anchoredCommand(options.command, 'CLAUDE_PROJECT_DIR')));
  // Without the skill text, init reports the missing skill once for every harness.
  if (options.skill === null) return steps;
  const skillFile = path.join(projectDir, SKILL);
  try {
    if (existsSync(skillFile) && readFileSync(skillFile, 'utf8') === options.skill) return [...steps, { status: 'kept', text: `The skill in ${SKILL} is up to date` }];
    writeProjectFile(projectDir, SKILL, options.skill);
    return [...steps, { status: 'done', text: `Installed the skill in ${SKILL}` }];
  } catch (error) {
    return [...steps, { status: 'failed', text: `Could not write ${SKILL}: ${message(error)}` }];
  }
}

function uninstall(projectDir: string): InstallStep[] {
  const steps = uninstallHooks(projectDir, claudeHooks());
  try {
    if (removeProjectFile(projectDir, SKILL)) steps.push({ status: 'done', text: `Removed the skill from ${SKILL}` });
  } catch (error) {
    steps.push({ status: 'failed', text: `Could not remove ${SKILL}: ${message(error)}` });
  }
  return steps;
}

export const claudeAdapter = defineAdapter({
  name: 'claude',
  title: 'Claude Code',
  markers: ['.claude', 'CLAUDE.md'],
  handlers: { 'pre-tool-use': handler('pre-tool-use'), stop: handler('stop'), 'subagent-stop': handler('subagent-stop'), 'post-compact': handler('post-compact') },
  install,
  uninstall,
});

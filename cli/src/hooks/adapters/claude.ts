// The Claude Code adapter. Claude Code runs `buckets hook <event>` (the entry without `--agent`) with its JSON on stdin.
// Every path exits with 0, so a hook never breaks the session; the decision travels in the JSON written to stdout.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../commands/io.js';
import { mergeHooks, removeHooks } from '../../commands/settings.js';
import { parseJson } from '../../core/json.js';
import { findProjectDir } from '../../core/project.js';
import type { Context } from '../../core/types.js';
import type { HookAdapter, InstallOptions, InstallStep } from '../adapter.js';
import { isForbiddenShell, isLockWrite, postEdit, preTool, stop, type ToolAction } from '../core.js';
import { isRecord, parseHookInput, str, type JsonRecord } from '../input.js';

export const HOOK_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop', 'subagent-stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function toolInput(input: JsonRecord): JsonRecord {
  return isRecord(input.tool_input) ? input.tool_input : {};
}

/** The core action of a Claude Code tool call. A file tool writes `file_path`, or `notebook_path` for NotebookEdit. */
export function claudeAction(input: JsonRecord): ToolAction {
  const tool = str(input.tool_name) ?? '';
  const args = toolInput(input);
  if (FILE_TOOLS.has(tool)) {
    const file = str(args.file_path) ?? str(args.notebook_path);
    return { kind: 'write', paths: file === undefined ? [] : [file] };
  }
  if (SHELL_TOOLS.has(tool)) return { kind: 'shell', command: str(args.command) ?? '' };
  return { kind: 'other' };
}

/**
 * True when the tool call would write the lock or approve a state without the native confirmation. With `where`,
 * a file path that does not name the lock is also compared with the real lock files on disk.
 */
export function touchesLock(input: JsonRecord, where?: { projectDir: string; cwd: string }): boolean {
  const action = claudeAction(input);
  if (action.kind === 'write') return action.paths.some((file) => isLockWrite(file, where));
  if (action.kind === 'shell') return isForbiddenShell(action.command);
  return false;
}

function blockJson(reason: string): string {
  return `${JSON.stringify({ decision: 'block', reason })}\n`;
}

async function run(ctx: Context, io: Io, event: string): Promise<number> {
  const fail = (detail: string): void => io.stderr(`buckets hook ${event}: unexpected error: ${detail}\n`);
  try {
    const input = parseHookInput(await io.readStdin());
    const projectDir = str(io.env.CLAUDE_PROJECT_DIR) ?? str(input.cwd) ?? io.cwd;
    // Relative paths resolve from the hook's cwd, or from the session project when Claude Code sends none.
    const cwd = str(input.cwd) ?? findProjectDir(projectDir) ?? io.cwd;
    const scope = { projectDir, cwd, ...(typeof input.session_id === 'string' ? { sessionId: input.session_id } : {}) };
    switch (event as HookEvent) {
      case 'pre-tool-use': {
        const result = preTool({ ...scope, action: claudeAction(input) });
        if (result.decision === 'deny') {
          io.stdout(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } })}\n`);
        } else if (result.error !== undefined) fail(result.error);
        return 0;
      }
      case 'post-tool-use': {
        const tool = str(input.tool_name) ?? '';
        const args = toolInput(input);
        const edited = EDIT_TOOLS.has(tool) ? str(args.file_path) : undefined;
        const other = FILE_TOOLS.has(tool) && edited === undefined ? (str(args.file_path) ?? str(args.notebook_path)) : undefined;
        if (edited === undefined && other === undefined) return 0;
        const result = await postEdit(ctx, { ...scope, paths: edited === undefined ? [] : [edited], touched: other === undefined ? [] : [other] });
        if (result.error !== undefined) fail(result.error);
        if (result.feedback !== undefined) io.stdout(blockJson(result.feedback));
        return 0;
      }
      case 'stop':
      case 'subagent-stop': {
        const result = await stop(ctx, { ...scope, active: input.stop_hook_active === true, subagent: event === 'subagent-stop' });
        if (result.error !== undefined) fail(result.error);
        if (result.block !== undefined) io.stdout(blockJson(result.block));
        return 0;
      }
    }
    return 0;
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 0;
  }
}

const SETTINGS = path.join('.claude', 'settings.json');
const SKILL = path.join('.claude', 'skills', 'slopbuckets', 'SKILL.md');

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const steps: InstallStep[] = [];
  const settingsFile = path.join(projectDir, SETTINGS);
  try {
    const current: unknown = existsSync(settingsFile) ? parseJson(readFileSync(settingsFile, 'utf8')) : {};
    const merged = mergeHooks(current);
    if (merged.added.length > 0) {
      writeJson(settingsFile, merged.settings);
      steps.push({ status: 'done', text: `Installed Claude Code hooks in .claude/settings.json (${merged.added.join(', ')})` });
    } else {
      steps.push({ status: 'kept', text: 'Claude Code hooks are already in .claude/settings.json' });
    }
  } catch (error) {
    steps.push({
      status: 'failed',
      text: `Could not install the hooks: ${error instanceof Error ? error.message : String(error)}. Fix .claude/settings.json and run \`buckets init\` again.`,
    });
  }
  // Without the skill text, init reports the missing skill once for every harness.
  if (options.skill !== null) {
    const skillFile = path.join(projectDir, SKILL);
    if (!existsSync(skillFile) || readFileSync(skillFile, 'utf8') !== options.skill) {
      mkdirSync(path.dirname(skillFile), { recursive: true });
      writeFileSync(skillFile, options.skill, 'utf8');
      steps.push({ status: 'done', text: 'Installed the skill in .claude/skills/slopbuckets/SKILL.md' });
    } else {
      steps.push({ status: 'kept', text: 'The skill in .claude/skills/slopbuckets/SKILL.md is up to date' });
    }
  }
  return steps;
}

function uninstall(projectDir: string): InstallStep[] {
  const steps: InstallStep[] = [];
  const settingsFile = path.join(projectDir, SETTINGS);
  if (existsSync(settingsFile)) {
    try {
      const result = removeHooks(parseJson(readFileSync(settingsFile, 'utf8')));
      if (result.removed.length > 0) {
        writeJson(settingsFile, result.settings);
        steps.push({ status: 'done', text: `Removed the slopbuckets hooks from .claude/settings.json (${result.removed.join(', ')})` });
      } else {
        steps.push({ status: 'kept', text: '.claude/settings.json has no slopbuckets hooks' });
      }
    } catch (error) {
      steps.push({ status: 'failed', text: `Could not remove the hooks: ${error instanceof Error ? error.message : String(error)}. Fix .claude/settings.json and try again.` });
    }
  }
  const skillFile = path.join(projectDir, SKILL);
  if (existsSync(skillFile)) {
    rmSync(skillFile, { force: true });
    try {
      if (readdirSync(path.dirname(skillFile)).length === 0) rmdirSync(path.dirname(skillFile));
    } catch {
      // A folder that cannot be listed or removed stays.
    }
    steps.push({ status: 'done', text: 'Removed the skill from .claude/skills/slopbuckets/SKILL.md' });
  }
  return steps;
}

export const claudeAdapter: HookAdapter = {
  name: 'claude',
  title: 'Claude Code',
  markers: ['.claude', 'CLAUDE.md'],
  events: HOOK_EVENTS,
  run,
  install,
  uninstall,
};

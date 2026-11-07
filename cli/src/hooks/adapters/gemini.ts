// The Gemini CLI adapter. Gemini reads the "hooks" key of `.gemini/settings.json`, in Claude Code's group shape with
// its own event names and timeouts in milliseconds, and ignores project settings in a folder the user has not trusted.
//
// BeforeTool can deny but drops `additionalContext`, so the pending list goes out by the post-tool fallback: AfterTool
// runs the pre-tool phase (or a pre-edit of the files as they are now) and appends the text to the tool result. The
// BeforeTool hook on edits only denies an edit that would make buckets.config.json invalid. It runs the core without a
// session id, so it does not mark anything as shown before AfterTool shows it. AfterAgent with `decision: "deny"` makes
// the agent go on with the reason; the retry carries stop_hook_active. Gemini has no subagent or post-compact event.
//
// Gemini reads stderr when stdout is empty and turns plain text with an exit code other than 0 or 1 into a deny, so a
// missing `buckets` (exit 127 in bash) would deny every matched call. Every command ends with `; exit 0`, which works
// in bash and PowerShell, the two shells Gemini uses. Install also points `context.fileName` at AGENTS.md.
import type { Io } from '../../context/index.js';
import { isRecord, JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { DEFAULT_COMMAND, groupEntries, installHooks, isAgentCommand, type JsonHookFile, uninstallHooks } from './json-install.js';
import { afterTool, decide, denyBeforeEdit, envPath, eventInput, jsonLine, snakeCall, stopFlag, type ToolKind, type Where, whereOf } from './json-run.js';

const AGENT = 'gemini';

const TOOLS: Record<string, ToolKind> = {
  write_file: 'write',
  replace: 'write',
  run_shell_command: 'shell',
  read_file: 'other',
  read_many_files: 'other',
  list_directory: 'other',
  glob: 'other',
  grep_search: 'other',
};

const where = (payload: JsonRecord, io: Io): Where => whereOf(payload, io, envPath(io, 'GEMINI_PROJECT_DIR'));

const beforeToolHook: HookHandler = async (ctx, io, payload) => {
  const reason = await denyBeforeEdit(ctx, where(payload, io), snakeCall(payload, TOOLS));
  if (reason !== undefined) io.stdout(jsonLine({ decision: 'deny', reason }));
  return 0;
};

const afterToolHook: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, afterTool(where(payload, io), snakeCall(payload, TOOLS)));
  if (decision.kind === 'context') io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: decision.text } }));
  return 0;
};

const afterAgent: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, eventInput(where(payload, io), 'stop', stopFlag(payload) === true));
  if (decision.kind === 'block') io.stdout(jsonLine({ decision: 'deny', reason: decision.text }));
  return 0;
};

/** The command of one event, made to exit with 0 in bash and in PowerShell even when the CLI is missing. */
const failOpen = (command: string): string => `${command}; exit 0`;

const CONTEXT_FILES = ['AGENTS.md', 'GEMINI.md'];

export function geminiHooks(cli: string = DEFAULT_COMMAND): JsonHookFile {
  return {
    agent: AGENT,
    title: 'Gemini CLI',
    file: '.gemini/settings.json',
    container: ['hooks'],
    layout: 'groups',
    ours: (command) => isAgentCommand(AGENT, command.replace(/;\s*exit 0\s*$/, '')),
    entries: groupEntries(
      AGENT,
      [
        { event: 'BeforeTool', name: 'before-tool', matcher: 'write_file|replace', extra: { name: 'slopbuckets-config-guard', timeout: 60_000 } },
        { event: 'AfterTool', name: 'after-tool', matcher: '.*', extra: { name: 'slopbuckets-pending', timeout: 60_000 } },
        { event: 'AfterAgent', name: 'after-agent', extra: { name: 'slopbuckets-check', timeout: 600_000 } },
      ],
      cli,
      failOpen,
    ),
    extra: contextFileName,
  };
}

/** Points `context.fileName` at AGENTS.md, so Gemini CLI reads the slopbuckets rules. */
function contextFileName(editor: Parameters<NonNullable<JsonHookFile['extra']>>[0]): InstallStep[] {
  const current = editor.get(['context', 'fileName']);
  const names = typeof current === 'string' ? [current] : Array.isArray(current) ? current : undefined;
  if (names?.includes('AGENTS.md')) return [];
  if (current === undefined) {
    const context = editor.get(['context']);
    if (context === undefined) editor.set(['context'], { fileName: CONTEXT_FILES });
    else if (isRecord(context)) editor.set(['context', 'fileName'], CONTEXT_FILES);
    else return [{ status: 'todo', text: 'Set "context.fileName" in .gemini/settings.json to ["AGENTS.md", "GEMINI.md"], so Gemini CLI reads the slopbuckets rules' }];
    return [{ status: 'done', text: 'Set "context.fileName" in .gemini/settings.json to AGENTS.md and GEMINI.md, so Gemini CLI reads the slopbuckets rules' }];
  }
  return [{ status: 'todo', text: 'Add "AGENTS.md" to "context.fileName" in .gemini/settings.json, so Gemini CLI reads the slopbuckets rules' }];
}

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const steps = installHooks(projectDir, geminiHooks(options.command));
  if (steps[0]?.status === 'done') {
    steps.push({ status: 'todo', text: 'Gemini CLI ignores project settings in an untrusted folder, and asks again when a hook command changes: trust this folder and the slopbuckets hooks when Gemini CLI asks' });
  }
  return steps;
}

export const geminiAdapter = defineAdapter({
  name: AGENT,
  title: 'Gemini CLI',
  markers: ['.gemini', 'GEMINI.md'],
  hookFiles: [geminiHooks().file],
  handlers: { 'before-tool': beforeToolHook, 'after-tool': afterToolHook, 'after-agent': afterAgent },
  install,
  // The context.fileName setting stays: it only adds AGENTS.md, which the user may read for other reasons.
  uninstall: (projectDir) => uninstallHooks(projectDir, geminiHooks()),
});

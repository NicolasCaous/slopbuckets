// The Gemini CLI adapter (hooks on by default since v0.26.0). Gemini reads the "hooks" key of `.gemini/settings.json`,
// in Claude Code's group shape but with its own event names and timeouts in milliseconds, and ignores project settings
// in a folder the user has not trusted. A deny is `{"decision":"deny"}`, which the model sees as a tool error. AfterAgent
// with `decision: deny` makes the agent retry with the reason, and the retry carries `stop_hook_active`. Gemini has no
// subagent stop event. Install also points `context.fileName` at AGENTS.md, which Gemini does not read by default.
import type { HookAdapter, InstallStep } from '../adapter.js';
import {
  groupEntries,
  installHookFile,
  jsonLine,
  runHook,
  scopeOf,
  snakeToolCall,
  stopFlag,
  uninstallHookFile,
  type HookFile,
  type RunConfig,
  type ToolKind,
} from './hook-kit.js';

const AGENT = 'gemini';
export const GEMINI_EVENTS = ['before-tool', 'after-tool', 'after-agent'] as const;

const TOOLS: Record<string, ToolKind> = {
  write_file: 'write',
  replace: 'write',
  edit: 'write',
  run_shell_command: 'shell',
  read_file: 'other',
  read_many_files: 'other',
  list_directory: 'other',
  glob: 'other',
  search_file_content: 'other',
  save_memory: 'other',
  write_todos: 'other',
};

export const geminiRun: RunConfig = {
  agent: AGENT,
  phases: { 'before-tool': 'pre-tool', 'after-tool': 'post-edit', 'after-agent': 'stop' },
  scope: (input, io) => scopeOf(input, io, { envVar: 'GEMINI_PROJECT_DIR' }),
  call: (input) => snakeToolCall(input, TOOLS),
  deny(io, reason) {
    io.stdout(jsonLine({ decision: 'deny', reason }));
    return 0;
  },
  feedback(io, text) {
    // `decision: deny` here would replace the tool result, so the report goes in additionalContext.
    io.stdout(jsonLine({ hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: text } }));
  },
  block(io, text) {
    io.stdout(jsonLine({ decision: 'deny', reason: text }));
  },
  stopActive: (input) => stopFlag(input),
};

const CONTEXT_FILES = ['AGENTS.md', 'GEMINI.md'];

export const GEMINI_HOOKS: HookFile = {
  agent: AGENT,
  title: 'Gemini CLI',
  file: '.gemini/settings.json',
  container: ['hooks'],
  layout: 'groups',
  entries: groupEntries(AGENT, [
    { event: 'BeforeTool', name: 'before-tool', matcher: 'write_file|replace|run_shell_command', extra: { name: 'slopbuckets-guard', timeout: 30_000 } },
    { event: 'AfterTool', name: 'after-tool', matcher: 'write_file|replace', extra: { name: 'slopbuckets-check-file', timeout: 300_000 } },
    { event: 'AfterAgent', name: 'after-agent', extra: { name: 'slopbuckets-check', timeout: 600_000 } },
  ]),
  extra(editor) {
    const current = editor.get(['context', 'fileName']);
    const names = typeof current === 'string' ? [current] : Array.isArray(current) ? current : undefined;
    if (names?.includes('AGENTS.md')) return [];
    if (current === undefined) {
      const context = editor.get(['context']);
      if (context === undefined) editor.set(['context'], { fileName: CONTEXT_FILES });
      else if (context !== null && typeof context === 'object' && !Array.isArray(context)) editor.set(['context', 'fileName'], CONTEXT_FILES);
      else return [{ status: 'todo', text: 'Set "context.fileName" in .gemini/settings.json to ["AGENTS.md", "GEMINI.md"], so Gemini CLI reads the slopbuckets rules' }];
      return [{ status: 'done', text: 'Set "context.fileName" in .gemini/settings.json to AGENTS.md and GEMINI.md, so Gemini CLI reads the slopbuckets rules' }];
    }
    return [{ status: 'todo', text: 'Add "AGENTS.md" to "context.fileName" in .gemini/settings.json, so Gemini CLI reads the slopbuckets rules' }];
  },
};

function install(projectDir: string): InstallStep[] {
  const steps = installHookFile(projectDir, GEMINI_HOOKS);
  if (steps[0]?.status === 'done') {
    steps.push({ status: 'todo', text: 'Gemini CLI ignores project settings in an untrusted folder: trust this folder when Gemini CLI asks, so the hooks run' });
  }
  return steps;
}

export const geminiAdapter: HookAdapter = {
  name: AGENT,
  title: 'Gemini CLI',
  markers: ['.gemini', 'GEMINI.md'],
  events: GEMINI_EVENTS,
  run: (ctx, io, event) => runHook(ctx, io, event, geminiRun),
  install,
  uninstall: (projectDir) => uninstallHookFile(projectDir, GEMINI_HOOKS),
};

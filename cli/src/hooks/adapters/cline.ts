// The Cline adapter (VS Code extension 4.x and the Cline CLI). Cline runs one script per event from
// `.clinerules/hooks/`: an executable file without extension on Unix (`PreToolUse`) and a PowerShell file on Windows
// (`PreToolUse.ps1`). Each script here only runs `buckets hook --agent cline <event>`, which reads the JSON Cline sends.
//
// Cline has no per-tool deny: `{"cancel": true}` from PreToolUse ends the whole task. So the hook cancels only for a
// write to the lock or the config, a plain `buckets refresh` or an installing `buckets update`, and says in `errorMessage` why the task stopped. PostToolUse hands
// the `buckets check --file` report back in `contextModification`. Nothing can block the end of a turn.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../commands/io.js';
import type { Context } from '../../core/types.js';
import type { HookAdapter, InstallStep } from '../adapter.js';
import { postEdit, preTool, type HookScope, type ToolAction } from '../core.js';
import { decodeArgs, isRecord, parseHookInput, str, type JsonRecord } from '../input.js';
import { capText, errorText, existingFiles, jsonLine, kindOf, reportError, toolCall, workspaceRoot, type ToolKind } from './hook-kit.js';

const AGENT = 'cline';
export const CLINE_EVENTS = ['pre-tool-use', 'post-tool-use'] as const;

/**
 * Cline 4.x tools (`editor`, `apply_patch`, `run_commands`) and the tool names of the older VS Code runtime, so a
 * workspace on an older build is still guarded.
 */
const TOOLS: Record<string, ToolKind> = {
  editor: 'write',
  apply_patch: 'patch',
  run_commands: 'shell',
  write_to_file: 'write',
  replace_in_file: 'write',
  execute_command: 'shell',
  read_files: 'other',
  read_file: 'other',
  search_codebase: 'other',
  fetch_web_content: 'other',
  skills: 'other',
  ask_question: 'other',
  submit_and_exit: 'other',
};

/** Cline cuts `contextModification` at 50 KB. */
const CONTEXT_LIMIT = 48_000;

/** The `preToolUse` or `postToolUse` part of a payload. */
function toolPart(input: JsonRecord, key: 'preToolUse' | 'postToolUse'): JsonRecord {
  const part = input[key];
  return isRecord(part) ? part : {};
}

/**
 * The parameters of a Cline tool call. Cline sends every value that is not a string as a JSON string
 * (`{"commands": "[\"npm test\"]"}`), so each such value is decoded back.
 */
export function clineParameters(part: JsonRecord): JsonRecord {
  const raw = decodeArgs(part.parameters);
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try {
        out[key] = JSON.parse(value) as unknown;
        continue;
      } catch {
        // A string that only looks like JSON stays a string.
      }
    }
    out[key] = value;
  }
  return out;
}

/** The shell commands of a `run_commands` call: strings, `{ command, args }` objects, or one bare command. */
export function clineCommands(args: JsonRecord): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') out.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (isRecord(value)) {
      const command = str(value.command) ?? str(value.cmd);
      if (command === undefined) return;
      const rest = Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === 'string') : [];
      out.push([command, ...rest].join(' '));
    }
  };
  add(args.commands);
  add(args.command);
  add(args.cmd);
  return out;
}

interface ClineCall {
  /** One action per command of a `run_commands` call, or the single action of any other tool. */
  actions: ToolAction[];
  edited: string[];
}

export function clineCall(part: JsonRecord): ClineCall {
  const tool = str(part.toolName) ?? '';
  const args = clineParameters(part);
  const kind = kindOf(tool, TOOLS);
  if (kind === 'shell') {
    const commands = clineCommands(args);
    return { actions: commands.map((command) => ({ kind: 'shell', command })), edited: [] };
  }
  const call = toolCall(kind, args, args.input);
  return { actions: [call.action], edited: call.edited };
}

/** The scope of a Cline call: the first workspace root, which is also the folder Cline runs the hook in. */
function clineScope(input: JsonRecord, io: Io): HookScope {
  const root = workspaceRoot(input) ?? io.cwd;
  const taskId = str(input.taskId);
  return { projectDir: root, cwd: root, ...(taskId === undefined ? {} : { sessionId: taskId }) };
}

/** The text Cline shows when the hook ends the task. It has to say why the whole task stopped. */
export function cancelMessage(tool: string, reason: string): string {
  return (
    `slopbuckets stopped this task: the ${tool === '' ? 'tool' : `\`${tool}\``} call would write buckets.lock.json or buckets.config.json, run \`buckets refresh\` without \`--web\`, or run \`buckets update\` without \`--check\` or \`--json\`. ` +
    'Cline hooks cannot refuse a single tool call, so refusing it ends the whole task. Start a new task and tell the agent to leave the lock, the config and CLI updates to you.\n\n' +
    reason
  );
}

const ALLOW = jsonLine({ cancel: false });

async function run(ctx: Context, io: Io, event: string): Promise<number> {
  try {
    const input = parseHookInput(await io.readStdin());
    const scope = clineScope(input, io);
    if (event === 'pre-tool-use') {
      const part = toolPart(input, 'preToolUse');
      for (const action of clineCall(part).actions) {
        const result = preTool({ ...scope, action });
        if (result.decision === 'deny') {
          io.stdout(jsonLine({ cancel: true, errorMessage: cancelMessage(str(part.toolName) ?? '', result.reason) }));
          return 0;
        }
        if (result.error !== undefined) reportError(io, AGENT, event, result.error);
      }
      io.stdout(ALLOW);
      return 0;
    }
    if (event === 'post-tool-use') {
      const part = toolPart(input, 'postToolUse');
      if (part.success === false) {
        io.stdout(ALLOW);
        return 0;
      }
      const paths = existingFiles(clineCall(part).edited, scope.cwd);
      if (paths.length > 0) {
        const result = await postEdit(ctx, { ...scope, paths });
        if (result.error !== undefined) reportError(io, AGENT, event, result.error);
        if (result.feedback !== undefined) {
          const context = capText(result.feedback, CONTEXT_LIMIT, 'Run `buckets check --file <path>` on each edited file for the full report.');
          io.stdout(jsonLine({ cancel: false, contextModification: context }));
          return 0;
        }
      }
      io.stdout(ALLOW);
      return 0;
    }
    return 0;
  } catch (error) {
    // A crash never ends the task: the core's failure rule allows before a tool and stays quiet after it.
    reportError(io, AGENT, event, errorText(error));
    io.stdout(ALLOW);
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Install

const HOOKS_DIR = '.clinerules/hooks';
/** The line that marks a hook script as written by slopbuckets, so install updates it and uninstall removes it. */
const MARK = 'slopbuckets: written by `buckets init --agent cline`';

const SCRIPTS: { file: string; event: string }[] = [
  { file: 'PreToolUse', event: 'pre-tool-use' },
  { file: 'PostToolUse', event: 'post-tool-use' },
];

/**
 * The Unix script. Cline's CLI also runs extensionless scripts on Windows, through sh, next to the `.ps1` file; the
 * `uname` test makes this one step aside there, so the hook runs once. Without the CLI it allows and says why.
 */
export function unixScript(event: string): string {
  return [
    '#!/bin/sh',
    `# ${MARK}. It edits only files that carry this line.`,
    '# Hands the JSON that Cline sends on stdin to slopbuckets. Docs: https://nicolascaous.github.io/slopbuckets/guide/agents/cline',
    'case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) echo \'{"cancel":false}\'; exit 0 ;; esac',
    `if command -v buckets >/dev/null 2>&1; then exec buckets hook --agent ${AGENT} ${event}; fi`,
    `echo "slopbuckets: the buckets command is not installed, so the Cline ${event} hook did nothing" >&2`,
    'echo \'{"cancel":false}\'',
    '',
  ].join('\n');
}

/**
 * The Windows script. Windows PowerShell hands its stdin and stdout straight to `buckets`. PowerShell 7 on another
 * system steps aside, because the Unix script runs there.
 */
export function powershellScript(event: string): string {
  return [
    `# ${MARK}. It edits only files that carry this line.`,
    '# Hands the JSON that Cline sends on stdin to slopbuckets. Docs: https://nicolascaous.github.io/slopbuckets/guide/agents/cline',
    "if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { '{\"cancel\":false}'; exit 0 }",
    'if (-not (Get-Command buckets -ErrorAction SilentlyContinue)) {',
    `  [Console]::Error.WriteLine('slopbuckets: the buckets command is not installed, so the Cline ${event} hook did nothing')`,
    "  '{\"cancel\":false}'",
    '  exit 0',
    '}',
    `& buckets hook --agent ${AGENT} ${event}`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

interface ScriptFile {
  rel: string;
  text: string;
  executable: boolean;
}

function scriptFiles(): ScriptFile[] {
  return SCRIPTS.flatMap(({ file, event }) => [
    { rel: `${HOOKS_DIR}/${file}`, text: unixScript(event), executable: true },
    { rel: `${HOOKS_DIR}/${file}.ps1`, text: powershellScript(event), executable: false },
  ]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function install(projectDir: string): InstallStep[] {
  const rules = path.join(projectDir, '.clinerules');
  try {
    if (existsSync(rules) && !statSync(rules).isDirectory()) {
      return [
        {
          status: 'todo',
          text: 'Did not install the Cline hooks: .clinerules is a single rules file, and Cline reads hooks only from a .clinerules/hooks/ folder. Move the rules to .clinerules/<name>.md and run `buckets init --agent cline` again.',
        },
      ];
    }
  } catch (error) {
    return [{ status: 'failed', text: `Could not read .clinerules: ${message(error)}` }];
  }
  const written: string[] = [];
  const foreign: string[] = [];
  let kept = 0;
  try {
    for (const script of scriptFiles()) {
      const file = path.join(projectDir, script.rel);
      if (existsSync(file)) {
        const current = readFileSync(file, 'utf8');
        if (!current.includes(MARK)) {
          foreign.push(script.rel);
          continue;
        }
        if (current === script.text) {
          if (script.executable) chmodSync(file, 0o755);
          kept++;
          continue;
        }
      }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, script.text, { encoding: 'utf8', mode: script.executable ? 0o755 : 0o644 });
      if (script.executable) chmodSync(file, 0o755);
      written.push(script.rel);
    }
  } catch (error) {
    return [{ status: 'failed', text: `Could not write the Cline hooks in ${HOOKS_DIR}/: ${message(error)}` }];
  }
  const steps: InstallStep[] = [];
  if (written.length > 0) steps.push({ status: 'done', text: `Installed the Cline hooks in ${HOOKS_DIR}/ (${written.map((rel) => path.posix.basename(rel)).join(', ')})` });
  else if (kept > 0) steps.push({ status: 'kept', text: `The Cline hooks in ${HOOKS_DIR}/ are up to date` });
  for (const rel of foreign) {
    const event = SCRIPTS.find((s) => rel.endsWith(`/${s.file}`) || rel.endsWith(`/${s.file}.ps1`))!.event;
    steps.push({
      status: 'todo',
      text: `${rel} is your own hook, so slopbuckets left it alone. Make it run \`buckets hook --agent ${AGENT} ${event}\` with the same stdin and print its output.`,
    });
  }
  if (written.length > 0) {
    steps.push({
      status: 'todo',
      text: 'Turn on hooks in Cline (VS Code: Settings, Feature Settings, Enable Hooks). The Cline CLI skips every hook with --yolo. Commit the scripts with the executable bit (`git update-index --chmod=+x .clinerules/hooks/PreToolUse .clinerules/hooks/PostToolUse` on Windows).',
    });
  }
  return steps;
}

function uninstall(projectDir: string): InstallStep[] {
  const removed: string[] = [];
  try {
    for (const script of scriptFiles()) {
      const file = path.join(projectDir, script.rel);
      if (!existsSync(file)) continue;
      if (!readFileSync(file, 'utf8').includes(MARK)) continue;
      rmSync(file, { force: true });
      removed.push(path.posix.basename(script.rel));
    }
    const dir = path.join(projectDir, HOOKS_DIR);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove the Cline hooks from ${HOOKS_DIR}/: ${message(error)}` }];
  }
  return removed.length === 0 ? [] : [{ status: 'done', text: `Removed the Cline hooks from ${HOOKS_DIR}/ (${removed.join(', ')})` }];
}

export const clineAdapter: HookAdapter = {
  name: AGENT,
  title: 'Cline',
  markers: ['.clinerules'],
  events: CLINE_EVENTS,
  run,
  install,
  uninstall,
};

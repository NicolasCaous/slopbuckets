// The Cline adapter (VS Code and JetBrains extension 4.x, and the Cline CLI 3.x). Cline runs one script per event from
// `.clinerules/hooks/`: an executable file without extension on Unix (`PreToolUse`) and a PowerShell file on Windows
// (`PreToolUse.ps1`). Each script here only runs `buckets hook --agent cline pre-tool-use`, which reads the JSON Cline
// sends.
//
// PreToolUse runs before every tool. `{"cancel": false, "contextModification": "..."}` adds text that Cline hands to the
// model after the tool results (extension 4.1.11 and CLI 3.0.56 or later). `{"cancel": true, "errorMessage": "..."}`
// refuses the call but ends the whole task, so the hook sends it only for a deny of the core: an edit that would make
// buckets.config.json invalid, which docs/guide/hooks.md says must not reach the disk. Cline has no stop, subagent stop or
// compaction event that a hook can use.
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../context/index.js';
import type { HookDecision, HookEdit, HookInput } from '../../contract/index.js';
import { isRecord, type JsonRecord } from '../../files/index.js';
import { message } from '../../output/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { patchEdits, replaceEdit } from '../edit-text.js';
import { decodeArgs, str } from '../input.js';
import { refuseLinks, removeProjectFile, writeProjectFile } from '../project-file.js';
import { commandParts, DEFAULT_COMMAND, hookCommand } from './json-install.js';
import { capText, decide, jsonLine, kindOf, pathsIn, toolInput, workspaceRoot, type ToolKind } from './json-run.js';

const AGENT = 'cline';

/** Cline 4.x tools and the tool names of the older VS Code runtime. */
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

/** Cline cuts the context at 50 KB. */
const CONTEXT_LIMIT = 48_000;

/**
 * The parameters of the legacy `preToolUse` block. Cline sends every value that is not a string as a JSON string
 * (`{"commands": "[\"npm test\"]"}`), so each such value is decoded back.
 */
export function clineParameters(part: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(decodeArgs(part.parameters))) {
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

/** The tool and its arguments: `tool_call` of the CLI 3.x payload (objects), else the legacy `preToolUse` block. */
export function clineTool(payload: JsonRecord): { tool: string; args: JsonRecord } {
  const call = payload.tool_call;
  if (isRecord(call) && str(call.name) !== undefined) return { tool: str(call.name)!, args: decodeArgs(call.input) };
  const part = isRecord(payload.preToolUse) ? payload.preToolUse : {};
  return { tool: str(part.toolName) ?? '', args: clineParameters(part) };
}

/**
 * The files a Cline call changes. `editor` creates a file when `old_text` is missing and replaces `old_text` with
 * `new_text` otherwise; `write_to_file` (older runtime) sends the whole `content`; `apply_patch` sends a patch in
 * `input`.
 */
export function clineEdits(tool: string, args: JsonRecord, root: string): HookEdit[] {
  const kind = kindOf(tool, TOOLS);
  if (kind === 'patch') {
    const patch = str(args.input) ?? str(args.patch);
    return patch === undefined ? [] : patchEdits(patch, root, root);
  }
  if (kind !== 'write' && kind !== 'delete') return [];
  const files = pathsIn(args).map((file) => path.resolve(root, file));
  if (kind === 'delete') return files.map((file) => ({ path: file, content: null }));
  if (files.length !== 1) return files.map((file) => ({ path: file }));
  const file = files[0]!;
  if (typeof args.content === 'string') return [{ path: file, content: args.content }];
  if (typeof args.new_text !== 'string' || args.insert_line !== undefined) return [{ path: file }];
  if (typeof args.old_text !== 'string') return [{ path: file, content: args.new_text }];
  return [replaceEdit(root, file, [{ old: args.old_text, new: args.new_text }], { emptyOld: 'new-file' })];
}

/** The core input of a Cline PreToolUse payload. A subagent has a `parent_agent_id` and its own `agent_id`. */
export function clineInput(payload: JsonRecord, io: Io): HookInput {
  const root = path.resolve(workspaceRoot(payload) ?? io.cwd);
  const { tool, args } = clineTool(payload);
  const sessionContext = isRecord(payload.sessionContext) ? payload.sessionContext : {};
  const where = {
    sessionId: str(payload.taskId) ?? str(sessionContext.rootSessionId) ?? null,
    agentId: str(payload.parent_agent_id) === undefined ? null : (str(payload.agent_id) ?? null),
    cwd: root,
    root,
  };
  return toolInput(where, tool, clineEdits(tool, args, root), kindOf(tool, TOOLS) === 'shell');
}

const NEUTRAL = jsonLine({ cancel: false });

export function clineOutput(decision: HookDecision): string {
  if (decision.kind === 'silent') return NEUTRAL;
  if (decision.kind === 'deny') return jsonLine({ cancel: true, errorMessage: decision.text });
  return jsonLine({ cancel: false, contextModification: capText(decision.text, CONTEXT_LIMIT, 'Run `buckets check` for the full list.') });
}

const preToolUse: HookHandler = async (ctx, io, payload) => {
  io.stdout(clineOutput(await decide(ctx, clineInput(payload, io))));
  return 0;
};

// ---------------------------------------------------------------------------------------------------------------
// Install

const HOOKS_DIR = '.clinerules/hooks';
const DOCS = 'https://nicolascaous.github.io/slopbuckets/docs/guide/agents/cline.html';
/** The line that marks a hook script as written by slopbuckets, so install updates it. */
const MARK = 'slopbuckets: written by `buckets init --agent cline`';

const SCRIPTS: { file: string; event: string }[] = [{ file: 'PreToolUse', event: 'pre-tool-use' }];

/**
 * The Unix script. Cline's CLI also runs extensionless scripts on Windows, through sh, next to the `.ps1` file; the
 * `uname` test makes this one step aside there, so the hook runs once. Without the CLI it answers neutrally and says why.
 */
export function unixScript(event: string, cli: string = DEFAULT_COMMAND): string {
  const { program, script } = commandParts(cli);
  return [
    '#!/bin/sh',
    `# ${MARK}. It edits only files that carry this line.`,
    `# Hands the JSON that Cline sends on stdin to slopbuckets. Docs: ${DOCS}`,
    'case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) echo \'{"cancel":false}\'; exit 0 ;; esac',
    `if command -v ${program} >/dev/null 2>&1${script === undefined ? '' : ` && [ -f ${script} ]`}; then exec ${hookCommand(AGENT, event, cli)}; fi`,
    `echo "slopbuckets: the buckets command is not installed, so the Cline ${event} hook did nothing" >&2`,
    'echo \'{"cancel":false}\'',
    '',
  ].join('\n');
}

/**
 * The Windows script. Windows PowerShell hands its stdin and stdout straight to `buckets`. PowerShell 7 on another
 * system steps aside, because the Unix script runs there.
 */
export function powershellScript(event: string, cli: string = DEFAULT_COMMAND): string {
  const { program, script } = commandParts(cli);
  const found = `(Get-Command ${program} -ErrorAction SilentlyContinue)`;
  return [
    `# ${MARK}. It edits only files that carry this line.`,
    `# Hands the JSON that Cline sends on stdin to slopbuckets. Docs: ${DOCS}`,
    "if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { '{\"cancel\":false}'; exit 0 }",
    script === undefined ? `if (-not ${found}) {` : `if (-not (${found} -and (Test-Path ${script}))) {`,
    `  [Console]::Error.WriteLine('slopbuckets: the buckets command is not installed, so the Cline ${event} hook did nothing')`,
    "  '{\"cancel\":false}'",
    '  exit 0',
    '}',
    `& ${hookCommand(AGENT, event, cli)}`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

interface ScriptFile {
  rel: string;
  text: string;
  executable: boolean;
}

function scriptFiles(cli: string = DEFAULT_COMMAND): ScriptFile[] {
  return SCRIPTS.flatMap(({ file, event }) => [
    { rel: `${HOOKS_DIR}/${file}`, text: unixScript(event, cli), executable: true },
    { rel: `${HOOKS_DIR}/${file}.ps1`, text: powershellScript(event, cli), executable: false },
  ]);
}

function install(projectDir: string, options: InstallOptions): InstallStep[] {
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
    for (const script of scriptFiles(options.command)) {
      const file = path.join(projectDir, script.rel);
      if (existsSync(file)) {
        const current = readFileSync(file, 'utf8');
        if (!current.includes(MARK)) {
          foreign.push(script.rel);
          continue;
        }
        if (current === script.text) {
          refuseLinks(projectDir, script.rel);
          if (script.executable) chmodSync(file, 0o755);
          kept++;
          continue;
        }
      }
      writeProjectFile(projectDir, script.rel, script.text, script.executable ? 0o755 : 0o644);
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
      text: 'Turn on hooks in Cline (VS Code: Settings, Feature Settings, Enable Hooks). The Cline CLI skips every hook with --yolo. Commit the scripts with the executable bit (`git update-index --chmod=+x .clinerules/hooks/PreToolUse` on Windows).',
    });
  }
  steps.push({
    status: 'todo',
    text: 'Cline has no stop hook, so it relies on the AGENTS.md instruction to run `buckets check` before it finishes. Run `buckets init --git-hook` to check every commit too.',
  });
  return steps;
}

function uninstall(projectDir: string): InstallStep[] {
  const removed: string[] = [];
  try {
    for (const { rel } of scriptFiles()) {
      const file = path.join(projectDir, rel);
      if (!existsSync(file) || !readFileSync(file, 'utf8').includes(MARK)) continue;
      removeProjectFile(projectDir, rel);
      removed.push(path.posix.basename(rel));
    }
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove the Cline hooks from ${HOOKS_DIR}/: ${message(error)}` }];
  }
  return removed.length === 0 ? [] : [{ status: 'done', text: `Removed the Cline hooks from ${HOOKS_DIR}/ (${removed.join(', ')})` }];
}

// A crash never ends the task: it answers the neutral `cancel: false`.
export const clineAdapter = defineAdapter({
  name: AGENT,
  title: 'Cline',
  markers: ['.clinerules'],
  handlers: { 'pre-tool-use': preToolUse },
  neutral: { 'pre-tool-use': NEUTRAL },
  install,
  uninstall,
});

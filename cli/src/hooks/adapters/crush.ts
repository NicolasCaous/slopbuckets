// The Crush adapter. Crush has one hook event, PreToolUse, and it runs for every tool of the top-level agent (not for
// sub-agents). The payload has `session_id`, `cwd`, `tool_name` and `tool_input`, and Crush sets `CRUSH_PROJECT_DIR`.
//
// The answer is a JSON envelope on stdout. `{"context": "..."}` adds text that Crush appends to the tool result, so the
// pending list reaches the model with the result of the call. `{"decision": "deny", "reason": "..."}` refuses one call,
// which is safe, so the pre-edit interrupt (config-invalid) uses it. The hook never answers `allow`: Crush takes it as
// approval and skips its permission prompt. Crush has no stop, subagent or compaction event.
//
// Install writes the hook to the project's crushrc (`.crushrc` or `crushrc`) when it has one, because a crushrc wins
// over the JSON config, and to `.crush.json` (or an existing `crush.json`) otherwise.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../context/index.js';
import type { HookEdit, HookInput } from '../../contract/index.js';
import { isRecord, type JsonRecord } from '../../files/index.js';
import { message } from '../../output/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { replaceEdit, type Replacement } from '../edit-text.js';
import { normalizeHarnessPath, str } from '../input.js';
import { writeProjectFile } from '../project-file.js';
import { anchoredCommand, DEFAULT_COMMAND, hookCommand, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { decide, jsonLine, toolInput } from './json-run.js';

const AGENT = 'crush';
const TITLE = 'Crush';

/** A replacement from an object with `old_string` and `new_string`, or undefined when either is missing. */
function replacement(value: unknown): Replacement | undefined {
  if (!isRecord(value) || typeof value.old_string !== 'string' || typeof value.new_string !== 'string') return undefined;
  return { old: value.old_string, new: value.new_string, all: value.replace_all === true };
}

/**
 * The files a Crush tool call changes, with their new text where the input gives it. An empty `old_string` on a missing
 * or empty file creates it, as Crush's edit does. Empty for any other tool.
 */
export function crushEdits(tool: string, args: JsonRecord, cwd: string, root: string): HookEdit[] {
  const file = str(args.file_path);
  if (file === undefined) return [];
  const abs = path.resolve(cwd, normalizeHarnessPath(file));
  switch (tool) {
    case 'write':
      return [typeof args.content === 'string' ? { path: abs, content: args.content } : { path: abs }];
    case 'edit':
    case 'multiedit': {
      const list = tool === 'edit' ? [replacement(args)] : Array.isArray(args.edits) ? args.edits.map(replacement) : [];
      return [list.includes(undefined) ? { path: abs } : replaceEdit(root, abs, list as Replacement[], { emptyOld: 'new-file' })];
    }
    // The new text is not in the input: the core shows the current list instead.
    case 'download':
    case 'lsp_replace_symbol':
      return [{ path: abs }];
    default:
      return [];
  }
}

/** The core input of a Crush payload. `lsp_rename` changes files that are not known before it runs, so it is pre-tool. */
export function crushInput(payload: JsonRecord, io: Io): HookInput {
  const cwdValue = str(payload.cwd);
  const cwd = path.resolve(cwdValue === undefined ? io.cwd : normalizeHarnessPath(cwdValue));
  const projectDir = str(io.env.CRUSH_PROJECT_DIR);
  const root = projectDir === undefined ? cwd : path.resolve(normalizeHarnessPath(projectDir));
  const tool = str(payload.tool_name) ?? '';
  const where = { sessionId: str(payload.session_id) ?? null, agentId: null, cwd, root };
  return toolInput(where, tool, crushEdits(tool, isRecord(payload.tool_input) ? payload.tool_input : {}, cwd, root), tool === 'bash');
}

/** Empty stdout is no opinion: the call runs and the permission prompt still asks. */
const preToolUse: HookHandler = async (ctx, io, payload) => {
  const decision = await decide(ctx, crushInput(payload, io));
  if (decision.kind === 'deny') io.stdout(jsonLine({ decision: 'deny', reason: decision.text }));
  else if (decision.kind === 'context') io.stdout(jsonLine({ context: decision.text }));
  return 0;
};

// ---------------------------------------------------------------------------------------------------------------
// Install

const JSON_FILES = ['.crush.json', 'crush.json'];
const RC_FILES = ['.crushrc', 'crushrc'];
const RC_MARK = '# slopbuckets';
/** The crushrc line of the hook, run with `cli`. */
export function crushRcLine(cli: string = DEFAULT_COMMAND): string {
  return `hook add PreToolUse --name slopbuckets --command '${hookCommand(AGENT, 'pre-tool-use', cli)}' --timeout 60  ${RC_MARK}`;
}
const RC_OURS = new RegExp(`^hook add PreToolUse .*buckets.* hook --agent ${AGENT} .*${RC_MARK}\\s*$`);

/** No matcher: the hook sees every tool, so the pending list shows before any call. */
function hookFile(file: string, cli: string = DEFAULT_COMMAND): JsonHookFile {
  const COMMAND = hookCommand(AGENT, 'pre-tool-use', cli);
  return {
    agent: AGENT,
    title: TITLE,
    file,
    container: ['hooks'],
    layout: 'flat',
    entries: [{ event: 'PreToolUse', command: COMMAND, entry: { name: 'slopbuckets', command: COMMAND, timeout: 60 } }],
  };
}

/** The config file install writes: an existing crushrc, else an existing JSON config, else `.crush.json`. */
export function crushTarget(projectDir: string): string {
  return [...RC_FILES, ...JSON_FILES].find((file) => existsSync(path.join(projectDir, file))) ?? '.crush.json';
}

function installRc(projectDir: string, file: string, cli: string | undefined): InstallStep[] {
  try {
    const line = crushRcLine(cli);
    const text = readFileSync(path.join(projectDir, file), 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    if (lines.includes(line)) return [{ status: 'kept', text: `${TITLE} hooks are already in ${file}` }];
    const kept = lines.filter((item) => !RC_OURS.test(item));
    const updated = kept.length < lines.length;
    if (kept[kept.length - 1] === '') kept.pop();
    writeProjectFile(projectDir, file, [...kept, line, ''].join(eol));
    return [{ status: 'done', text: updated ? `Updated the ${TITLE} hooks in ${file} (PreToolUse)` : `Installed ${TITLE} hooks in ${file} (PreToolUse)` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not install the ${TITLE} hooks: ${message(error)}. Fix ${file} and run \`buckets init\` again.` }];
  }
}

const NO_STOP: InstallStep = {
  status: 'todo',
  text: 'Crush has no stop hook, so it relies on the AGENTS.md instruction to run `buckets check` before it finishes. Run `buckets init --git-hook` to check every commit too.',
};

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const target = crushTarget(projectDir);
  // Crush runs hooks in its embedded POSIX shell on every system.
  const cli = anchoredCommand(options.command, 'CRUSH_PROJECT_DIR');
  const steps = RC_FILES.includes(target) ? installRc(projectDir, target, cli) : installHooks(projectDir, hookFile(target, cli));
  return steps.some((step) => step.status === 'failed') ? steps : [...steps, NO_STOP];
}

function uninstallRc(projectDir: string, file: string): InstallStep[] {
  const abs = path.join(projectDir, file);
  if (!existsSync(abs)) return [];
  try {
    const text = readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    const kept = lines.filter((line) => !RC_OURS.test(line));
    if (kept.length === lines.length) return [];
    if (kept.every((line) => line.trim() === '')) {
      rmSync(abs, { force: true });
      return [{ status: 'done', text: `Removed ${file}, which held only the slopbuckets hook` }];
    }
    writeProjectFile(projectDir, file, kept.join(text.includes('\r\n') ? '\r\n' : '\n'));
    return [{ status: 'done', text: `Removed the slopbuckets hooks from ${file} (PreToolUse)` }];
  } catch (error) {
    return [{ status: 'failed', text: `Could not remove the ${TITLE} hooks: ${message(error)}. Fix ${file} and run \`buckets uninstall\` again.` }];
  }
}

export const crushAdapter = defineAdapter({
  name: AGENT,
  title: TITLE,
  markers: ['.crush.json', 'crush.json', '.crushrc', 'crushrc', '.crush'],
  hookFiles: [...JSON_FILES, ...RC_FILES],
  handlers: { 'pre-tool-use': preToolUse },
  install,
  uninstall: (projectDir) => [...RC_FILES.flatMap((file) => uninstallRc(projectDir, file)), ...JSON_FILES.flatMap((file) => uninstallHooks(projectDir, hookFile(file)))],
});

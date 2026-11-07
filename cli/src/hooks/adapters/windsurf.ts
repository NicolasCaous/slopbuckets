// The Windsurf adapter: Cascade, the older agent of Devin Desktop (formerly Windsurf). Cascade reads workspace hooks
// from `.devin/hooks.json`, and from the legacy `.windsurf/hooks.json` only when the first is absent or defines no
// hooks.
//
// Cascade hooks can only refuse: exit code 2 blocks the action and Cascade hands stderr to the model. Nothing else a
// hook prints reaches the model, so there is no way to show the pending list. slopbuckets installs one hook,
// `pre_write_code`, for the pre-edit interrupt: an edit that would make buckets.config.json invalid is refused. Every
// other answer of the core is dropped. Cascade has no stop, subagent or compaction event, so it relies on the AGENTS.md
// instruction to run `buckets check` and on the git pre-commit hook.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Io } from '../../context/index.js';
import type { HookEdit, HookInput } from '../../contract/index.js';
import { isRecord, JsoncText, type JsonRecord } from '../../files/index.js';
import { defineAdapter, type HookHandler, type InstallOptions, type InstallStep } from '../adapter.js';
import { replaceEdit, type Replacement } from '../edit-text.js';
import { normalizeHarnessPath, str } from '../input.js';
import { DEFAULT_COMMAND, hookCommand, installHooks, type JsonHookFile, uninstallHooks } from './json-install.js';
import { decide, toolInput } from './json-run.js';

const AGENT = 'windsurf';
const TITLE = 'Windsurf Cascade';

export const WINDSURF_FILE = '.devin/hooks.json';
export const WINDSURF_LEGACY_FILE = '.windsurf/hooks.json';

/**
 * The core input of a `pre_write_code` payload: `tool_info.file_path` and `tool_info.edits[]` with `old_string` and
 * `new_string`, applied to the file on disk. Cascade runs a workspace hook from the root of the repository.
 */
export function windsurfInput(payload: JsonRecord, io: Io): HookInput {
  const info = isRecord(payload.tool_info) ? payload.tool_info : {};
  const file = str(info.file_path);
  const pairs = (Array.isArray(info.edits) ? info.edits : []).map((e): Replacement | undefined =>
    isRecord(e) && typeof e.old_string === 'string' && typeof e.new_string === 'string' ? { old: e.old_string, new: e.new_string } : undefined,
  );
  const edits: HookEdit[] = [];
  if (file !== undefined) {
    const abs = path.resolve(io.cwd, normalizeHarnessPath(file));
    edits.push(pairs.includes(undefined) ? { path: abs } : replaceEdit(io.cwd, abs, pairs as Replacement[], { emptyOld: 'new-file' }));
  }
  const where = { sessionId: str(payload.trajectory_id) ?? null, agentId: null, cwd: io.cwd, root: io.cwd };
  return toolInput(where, str(payload.agent_action_name) ?? '', edits, false);
}

const preWriteCode: HookHandler = async (ctx, io, payload) => {
  const input = windsurfInput(payload, io);
  if (input.edits.length === 0) return 0;
  const decision = await decide(ctx, input);
  if (decision.kind !== 'deny') return 0;
  io.stderr(`${decision.text}\n`);
  return 2;
};

// ---------------------------------------------------------------------------------------------------------------
// Install

function hookFile(file: string, cli: string = DEFAULT_COMMAND): JsonHookFile {
  const COMMAND = hookCommand(AGENT, 'pre-write-code', cli);
  return {
    agent: AGENT,
    title: TITLE,
    file,
    container: ['hooks'],
    layout: 'flat',
    // `powershell -Command` exits with 1 on any failure, so the exit code of buckets is passed on by hand.
    entries: [{ event: 'pre_write_code', command: COMMAND, entry: { command: COMMAND, powershell: `${COMMAND}; exit $LASTEXITCODE`, show_output: true } }],
  };
}

/** True when the file defines at least one hook. A file that exists but cannot be read counts as defining hooks. */
function definesHooks(file: string): boolean {
  try {
    const doc = new JsoncText(readFileSync(file, 'utf8'));
    const value = doc.valueOf(doc.root) as unknown;
    if (!isRecord(value) || !isRecord(value.hooks)) return false;
    return Object.values(value.hooks).some((list) => Array.isArray(list) && list.length > 0);
  } catch {
    return true;
  }
}

/**
 * The file Cascade reads for this workspace: `.devin/hooks.json` when it defines hooks, else the legacy
 * `.windsurf/hooks.json` when it exists (writing `.devin/hooks.json` then would hide the user's hooks), else
 * `.devin/hooks.json`.
 */
export function windsurfTarget(projectDir: string): string {
  const primary = path.join(projectDir, WINDSURF_FILE);
  if (existsSync(primary) && definesHooks(primary)) return WINDSURF_FILE;
  if (existsSync(path.join(projectDir, WINDSURF_LEGACY_FILE))) return WINDSURF_LEGACY_FILE;
  return WINDSURF_FILE;
}

const NO_STOP: InstallStep = {
  status: 'todo',
  text: 'Windsurf Cascade hooks can only refuse an edit, so the hook only stops edits that would break buckets.config.json. Cascade relies on the AGENTS.md instruction to run `buckets check` before it finishes; run `buckets init --git-hook` to check every commit too.',
};

function install(projectDir: string, options: InstallOptions): InstallStep[] {
  const target = windsurfTarget(projectDir);
  const steps = installHooks(projectDir, hookFile(target, options.command));
  if (steps.some((step) => step.status === 'failed')) return steps;
  if (target === WINDSURF_LEGACY_FILE && steps[0]?.status === 'done') {
    steps.push({
      status: 'todo',
      text: 'The hooks went to the legacy .windsurf/hooks.json, which Cascade reads only while .devin/hooks.json defines no hooks. If you move your hooks to .devin/hooks.json, run `buckets init --agent windsurf` again.',
    });
  }
  return [...steps, NO_STOP];
}

export const windsurfAdapter = defineAdapter({
  name: AGENT,
  title: TITLE,
  markers: ['.windsurf', '.windsurfrules', WINDSURF_FILE],
  hookFiles: [WINDSURF_FILE, WINDSURF_LEGACY_FILE],
  handlers: { 'pre-write-code': preWriteCode },
  install,
  uninstall: (projectDir) => [WINDSURF_FILE, WINDSURF_LEGACY_FILE].flatMap((file) => uninstallHooks(projectDir, hookFile(file))),
});

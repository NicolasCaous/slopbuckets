// The protocol between `buckets hook --agent <name> <event>` and the code plugins that OpenCode, Pi and Amp load. Those
// harnesses have no shell hooks, so slopbuckets writes a small plugin file into the project (see ./plugins/) that spawns
// the CLI for each event. The plugin sends one JSON object on stdin and reads one JSON line on stdout. The decisions
// stay in the hook core (./core.ts); the plugin only applies the answer with the harness API.
//
// Events are the hook phases. A plugin sends every tool call as `pre-tool`, and the adapter turns it into `pre-edit`
// when the call edits files it can name, so the plugin needs no tool table. `pre-edit` is accepted too and handled the
// same way.
//
// Input (every field optional):
//   { cwd, root, sessionId, agentId, tool, args, paths, command, stopHookActive }
//   `tool` and `args` are the raw tool call. `paths` and `command` are for a harness whose plugin API already names
//   the files a call modifies or the shell command it runs (Amp). `stopHookActive` is true when the plugin already
//   continued the agent once in this turn.
// Output, always one line and exit code 0: the HookDecision of ../contract/hooks.ts, such as
//   {"kind":"silent"}, {"kind":"context","text":"..."}, {"kind":"deny","text":"..."} or {"kind":"block","text":"..."}.
import path from 'node:path';
import type { Io } from '../context/index.js';
import { HOOK_PHASES, PHASE_DECISIONS, type HookDecision, type HookEdit, type HookInput, type HookPhase } from '../contract/index.js';
import { isRecord, type JsonRecord } from '../files/index.js';
import { unexpectedError } from '../output/index.js';
import type { HookContext, HookHandler } from './adapter.js';
import { hookCore } from './core.js';
import { fileEdit, patchEdits, patchTextOf, readProjectText, replaceText, type Replacement, type ReplaceOptions } from './edit-text.js';
import { normalizeHarnessPath, str } from './input.js';


/** One tool call as the plugin reports it. */
export interface PluginToolCall {
  tool: string;
  args: JsonRecord;
  /** Files the harness says the call modifies. */
  paths?: string[];
  /** The shell command the harness says the call runs. */
  command?: string;
}

/** The tool names of a harness, by what they do. */
export interface ToolTable {
  shell: string[];
  /** Tools that change the one file in `filePath` or `path`. */
  edit: string[];
  /** Tools that take an apply_patch style patch. */
  patch: string[];
  /** What an empty old string of an edit does, when the harness documents it (see ReplaceOptions). */
  emptyOld?: ReplaceOptions['emptyOld'];
}

export interface ToolMeaning {
  edits: HookEdit[];
  isShell: boolean;
}

const SILENT: HookDecision = { kind: 'silent' };

/** The first string under any of `keys`. Old and new texts may be empty, so this does not use `str`. */
function pick(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string;
  return undefined;
}

const OLD_KEYS = ['oldString', 'old_string', 'old_str', 'oldText'];
const NEW_KEYS = ['newString', 'new_string', 'new_str', 'newText'];

/**
 * The edit of `file` after a write or an edit call, with the new text unless the arguments do not say it or the edit
 * would not apply. It understands `content` (a write), one old and new string pair, and Pi's `edits` list.
 */
export function newContent(file: string, args: JsonRecord, root: string, table: Pick<ToolTable, 'emptyOld'> = {}): HookEdit {
  if (typeof args.content === 'string') return { path: file, content: args.content };
  const all = args.replaceAll === true || args.replace_all === true;
  const list: Replacement[] = [];
  for (const pair of Array.isArray(args.edits) ? args.edits.filter(isRecord) : [args]) {
    const oldText = pick(pair, OLD_KEYS);
    const newText = pick(pair, NEW_KEYS);
    if (oldText === undefined || newText === undefined) return { path: file };
    list.push({ old: oldText, new: newText, all });
  }
  // A whole-file write needs no text from disk, so the file is not read for it.
  const whole = table.emptyOld === 'whole' && list.length > 0 && list.every((r) => r.old === '');
  const text = whole ? null : readProjectText(root, file);
  return fileEdit(file, text === undefined ? undefined : replaceText(text, list, { emptyOld: table.emptyOld }));
}

/**
 * What a tool call does, from the harness's tool table. A call with `command` is a shell call. A call with `paths`
 * edits those files, whatever its name. Edits carry the new text when the arguments give it.
 */
export function toolMeaning(table: ToolTable, call: PluginToolCall, cwd: string, root: string = cwd): ToolMeaning {
  const { tool, args } = call;
  if (call.command !== undefined || table.shell.includes(tool)) return { edits: [], isShell: true };
  const patch = (call.paths?.length ?? 0) > 0 || table.patch.includes(tool) ? patchTextOf(args) : undefined;
  if (patch !== undefined) return { edits: patchEdits(patch, cwd, root), isShell: false };
  const named = str(args.filePath) ?? str(args.path);
  const paths = call.paths ?? (table.edit.includes(tool) && named !== undefined ? [named] : []);
  const edits = paths.map((file): HookEdit => {
    const full = path.resolve(cwd, normalizeHarnessPath(file));
    return paths.length === 1 ? newContent(full, args, root, table) : { path: full };
  });
  return { edits, isShell: false };
}

/** Turns the payload of a plugin call into the HookInput of `event`. */
export function pluginInput(raw: JsonRecord, event: HookPhase, defaultCwd: string, table: ToolTable): HookInput {
  const cwd = normalizeHarnessPath(str(raw.cwd) ?? defaultCwd);
  const root = str(raw.root) === undefined ? cwd : normalizeHarnessPath(str(raw.root)!);
  const tool = str(raw.tool) ?? null;
  const base = {
    sessionId: str(raw.sessionId) ?? null,
    agentId: str(raw.agentId) ?? null,
    cwd,
    root,
    stopHookActive: raw.stopHookActive === true,
  };
  if (event !== 'pre-tool' && event !== 'pre-edit') return { ...base, phase: event, toolName: null, edits: [], isShell: false };
  const call: PluginToolCall = { tool: tool ?? '', args: isRecord(raw.args) ? raw.args : {} };
  if (Array.isArray(raw.paths)) call.paths = raw.paths.filter((p): p is string => typeof p === 'string' && p !== '');
  if (typeof raw.command === 'string') call.command = raw.command;
  const { edits, isShell } = tool === null ? { edits: [], isShell: false } : toolMeaning(table, call, cwd, root);
  return { ...base, phase: edits.length > 0 ? 'pre-edit' : 'pre-tool', toolName: tool, edits, isShell };
}

/**
 * Answers one plugin call: asks the core and writes the decision as one JSON line. It always returns 0. A crash, or a
 * decision the phase does not allow, answers silent, so the plugin lets the tool run and never loops.
 */
async function answer(ctx: HookContext, io: Io, event: HookPhase, table: ToolTable, payload: JsonRecord): Promise<number> {
  let decision = SILENT;
  try {
    const input = pluginInput(payload, event, io.cwd, table);
    const reply = await (ctx.hookCore ?? hookCore)(input, ctx.engine);
    if (PHASE_DECISIONS[input.phase].includes(reply.kind)) decision = reply;
  } catch (error) {
    io.stderr(unexpectedError(`buckets hook ${event}`, error));
  }
  io.stdout(`${JSON.stringify(decision)}\n`);
  return 0;
}

/** The handlers of a harness that supports `phases`, in the order of HOOK_PHASES. */
export function pluginHandlers<P extends HookPhase>(table: ToolTable, ...phases: P[]): Record<P, HookHandler> {
  const handlers = {} as Record<P, HookHandler>;
  for (const phase of HOOK_PHASES.filter((p): p is P => (phases as HookPhase[]).includes(p))) {
    handlers[phase] = (ctx, io, payload) => answer(ctx, io, phase, table, payload);
  }
  return handlers;
}

/** The answer of a plugin call that crashed before it could print one. */
export const PLUGIN_NEUTRAL = `${JSON.stringify(SILENT)}\n`;

// The protocol between `buckets hook --agent <name> <event>` and the code plugins that OpenCode, Pi and Amp load. Those
// harnesses have no shell hooks, so slopbuckets writes a small plugin file into the project (see ./plugins/) that spawns
// the CLI for every guarded tool call. The plugin sends one JSON object on stdin and reads one JSON line on stdout. All
// decisions stay here and in ./core.ts; the plugin only applies the answer with the harness API.
//
// Input (every field optional):
//   { cwd, projectDir, sessionId, api, tool, args, paths, command, commandCwd }
//   `tool` and `args` are the raw tool call; `paths` and `command` are for harnesses whose plugin API already extracts
//   them (Amp). `api` names the plugin API line, such as `v1` or `v2` for OpenCode.
// Output, always one line and exit code 0:
//   pre-tool-use:  { "decision": "allow" } or { "decision": "deny", "reason": "..." }
//   post-tool-use: {} or { "feedback": "..." }
//   stop and subagent-stop: {} or { "block": "..." }
import type { Io } from '../commands/io.js';
import type { Context } from '../core/types.js';
import { LOCK_DENY_REASON, postEdit, preTool, stop, type ToolAction } from './core.js';
import { isRecord, normalizeHarnessPath, parseHookInput, str, type JsonRecord } from './input.js';

export const PLUGIN_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop', 'subagent-stop'] as const;
export type PluginEvent = (typeof PLUGIN_EVENTS)[number];

/** What one tool call means for the hooks: the action for the lock guard and the files to check after it ran. */
export interface PluginToolCall {
  action: ToolAction;
  /** Files the tool left edited, checked with `buckets check --file` after the call. */
  edited: string[];
}

/** Turns the normalized input of a plugin into the action of the core. Each adapter knows its harness's tool names. */
export type PluginToolMapper = (input: PluginInput) => PluginToolCall;

/** The normalized input, as the plugin sends it. */
export interface PluginInput {
  tool: string;
  args: JsonRecord;
  api: string | undefined;
  /** Paths the plugin already extracted, such as Amp's `filesModifiedByToolCall`. */
  paths: string[] | undefined;
  command: string | undefined;
  commandCwd: string | undefined;
}

export const NO_TOOL_CALL: PluginToolCall = { action: { kind: 'other' }, edited: [] };

/** The `str` value of a field, as a path made usable by `path.resolve`. */
export function pathArg(args: JsonRecord, key: string): string | undefined {
  const value = str(args[key]);
  return value === undefined ? undefined : normalizeHarnessPath(value);
}

/** Decodes the stdin of a plugin call. Never throws: anything malformed reads as an empty call. */
export function parsePluginInput(text: string): { input: PluginInput; raw: JsonRecord } {
  const raw = parseHookInput(text);
  const paths = Array.isArray(raw.paths) ? raw.paths.filter((p): p is string => typeof p === 'string' && p !== '').map(normalizeHarnessPath) : undefined;
  return {
    raw,
    input: {
      tool: str(raw.tool) ?? '',
      args: isRecord(raw.args) ? raw.args : {},
      api: str(raw.api),
      paths,
      command: typeof raw.command === 'string' ? raw.command : undefined,
      commandCwd: str(raw.commandCwd),
    },
  };
}

export interface PluginRunOptions {
  /** Rewrites the core's deny reason (of the lock or of the config) for this harness. Defaults to no change. */
  denyReason?: (reason: string) => string;
}

/** A deny reason with the name of the read tool of a harness whose tools have lowercase names. */
export function lowercaseReadTool(reason: string): string {
  return reason.replace('use the Read tool', 'use the read tool');
}

/** The lock deny reason for a harness whose tools have lowercase names. */
export const LOWERCASE_READ_DENY_REASON = lowercaseReadTool(LOCK_DENY_REASON);

/**
 * Runs one plugin hook call. It always writes one JSON line and returns 0, so the plugin can tell a real answer from a
 * crash of the process. A crash inside follows the core's failure rule: allow before a tool, report after an edit,
 * block once at a stop.
 */
export async function runPluginHook(ctx: Context, io: Io, event: string, mapper: PluginToolMapper, options: PluginRunOptions = {}): Promise<number> {
  const answer = (value: JsonRecord): number => {
    io.stdout(`${JSON.stringify(value)}\n`);
    return 0;
  };
  const fail = (detail: string): void => io.stderr(`buckets hook ${event}: unexpected error: ${detail}\n`);
  try {
    const { input, raw } = parsePluginInput(await io.readStdin());
    const cwd = str(raw.cwd) ?? io.cwd;
    const scope = {
      projectDir: str(raw.projectDir) ?? cwd,
      cwd,
      ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    };
    switch (event as PluginEvent) {
      case 'pre-tool-use': {
        const result = preTool({ ...scope, action: mapper(input).action });
        if (result.decision === 'deny') return answer({ decision: 'deny', reason: options.denyReason ? options.denyReason(result.reason) : result.reason });
        if (result.error !== undefined) fail(result.error);
        return answer({ decision: 'allow' });
      }
      case 'post-tool-use': {
        const { edited } = mapper(input);
        if (edited.length === 0) return answer({});
        const result = await postEdit(ctx, { ...scope, paths: edited });
        if (result.error !== undefined) fail(result.error);
        return answer(result.feedback === undefined ? {} : { feedback: result.feedback });
      }
      case 'stop':
      case 'subagent-stop': {
        const result = await stop(ctx, { ...scope, active: raw.active === true, subagent: event === 'subagent-stop' });
        if (result.error !== undefined) fail(result.error);
        return answer(result.block === undefined ? {} : { block: result.block });
      }
    }
    return answer({});
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return answer(event === 'pre-tool-use' ? { decision: 'allow' } : {});
  }
}

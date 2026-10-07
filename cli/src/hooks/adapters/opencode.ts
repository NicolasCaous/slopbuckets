// The OpenCode adapter. OpenCode has no shell hooks, so `install` writes a plugin into .opencode/plugins/ that serves
// both API lines, and the plugin calls `buckets hook --agent opencode <event>` with the normalized protocol of
// ../plugin-protocol.ts. The plugin says which line it runs on in `api`, because the two lines name tools differently:
//
// - V1 (`opencode-ai`): edit, write and multiedit write `filePath`; apply_patch and patch carry `patchText`; bash runs
//   `command` in `workdir`.
// - V2 (`@opencode/cli`): edit and write write `path`; patch carries `patchText`; shell runs `command` in `workdir`.
import type { HookAdapter } from '../adapter.js';
import { patchEditedPaths, patchPaths, str } from '../input.js';
import { installPluginFile, uninstallPluginFile, type PluginFileSpec } from '../plugin-file.js';
import { lowercaseReadTool, NO_TOOL_CALL, PLUGIN_EVENTS, pathArg, runPluginHook, type PluginInput, type PluginToolCall } from '../plugin-protocol.js';
import { OPENCODE_PLUGIN } from '../plugins/opencode.js';

interface ToolTable {
  file: Set<string>;
  fileKey: string;
  patch: Set<string>;
  shell: Set<string>;
}

const TOOLS: Record<'v1' | 'v2', ToolTable> = {
  v1: { file: new Set(['edit', 'write', 'multiedit']), fileKey: 'filePath', patch: new Set(['apply_patch', 'patch']), shell: new Set(['bash']) },
  v2: { file: new Set(['edit', 'write']), fileKey: 'path', patch: new Set(['patch']), shell: new Set(['shell']) },
};

/** The core action of an OpenCode tool call. A call without `api` is read as V1. */
export function opencodeToolCall(input: PluginInput): PluginToolCall {
  const table = TOOLS[input.api === 'v2' ? 'v2' : 'v1'];
  const { tool, args } = input;
  if (table.file.has(tool)) {
    const file = pathArg(args, table.fileKey);
    const paths = file === undefined ? [] : [file];
    return { action: { kind: 'write', paths }, edited: paths };
  }
  if (table.patch.has(tool)) {
    const text = str(args.patchText) ?? '';
    return { action: { kind: 'write', paths: patchPaths(text) }, edited: patchEditedPaths(text) };
  }
  if (table.shell.has(tool)) {
    const cwd = pathArg(args, 'workdir');
    return { action: { kind: 'shell', command: typeof args.command === 'string' ? args.command : '', ...(cwd === undefined ? {} : { cwd }) }, edited: [] };
  }
  return NO_TOOL_CALL;
}

export const OPENCODE_PLUGIN_FILE: PluginFileSpec = {
  title: 'OpenCode',
  dir: '.opencode/plugins',
  name: 'slopbuckets.ts',
  altName: 'slopbuckets-hooks.ts',
  content: OPENCODE_PLUGIN,
};

export const opencodeAdapter: HookAdapter = {
  name: 'opencode',
  title: 'OpenCode',
  markers: ['.opencode', 'opencode.json', 'opencode.jsonc'],
  events: PLUGIN_EVENTS,
  run: (ctx, io, event) => runPluginHook(ctx, io, event, opencodeToolCall, { denyReason: lowercaseReadTool }),
  install: (projectDir) => [installPluginFile(projectDir, OPENCODE_PLUGIN_FILE)],
  uninstall: (projectDir) => uninstallPluginFile(projectDir, OPENCODE_PLUGIN_FILE),
};

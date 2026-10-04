// The Amp adapter. Amp loads plugins, not shell hooks, so `install` writes .amp/plugins/slopbuckets.ts, which calls
// `buckets hook --agent amp <event>` with the normalized protocol of ../plugin-protocol.ts. Amp's plugin API names the
// files a tool modifies (`amp.helpers.filesModifiedByToolCall`) and the command a shell tool runs
// (`amp.helpers.shellCommandFromToolCall`), so the plugin sends `paths`, `command` and `commandCwd` and this adapter
// does not need Amp's tool names.
import type { HookAdapter } from '../adapter.js';
import { installPluginFile, uninstallPluginFile, type PluginFileSpec } from '../plugin-file.js';
import { NO_TOOL_CALL, runPluginHook, type PluginInput, type PluginToolCall } from '../plugin-protocol.js';
import { AMP_PLUGIN } from '../plugins/amp.js';

export const AMP_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop'] as const;

/** The core action of an Amp tool call, from the paths and the command the plugin extracted. */
export function ampToolCall(input: PluginInput): PluginToolCall {
  const paths = input.paths ?? [];
  if (paths.length > 0) return { action: { kind: 'write', paths }, edited: paths };
  if (input.command !== undefined) {
    return { action: { kind: 'shell', command: input.command, ...(input.commandCwd === undefined ? {} : { cwd: input.commandCwd }) }, edited: [] };
  }
  return NO_TOOL_CALL;
}

export const AMP_PLUGIN_FILE: PluginFileSpec = {
  title: 'Amp',
  dir: '.amp/plugins',
  name: 'slopbuckets.ts',
  altName: 'slopbuckets-hooks.ts',
  content: AMP_PLUGIN,
};

export const ampAdapter: HookAdapter = {
  name: 'amp',
  title: 'Amp',
  markers: ['.amp'],
  events: AMP_EVENTS,
  run: (ctx, io, event) => runPluginHook(ctx, io, event, ampToolCall),
  install: (projectDir) => [installPluginFile(projectDir, AMP_PLUGIN_FILE)],
  uninstall: (projectDir) => uninstallPluginFile(projectDir, AMP_PLUGIN_FILE),
};

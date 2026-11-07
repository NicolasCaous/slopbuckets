// The Amp adapter. Amp loads plugins, not shell hooks, so `install` writes .amp/plugins/slopbuckets.ts, which calls
// `buckets hook --agent amp <event>` with the protocol of ../plugin-protocol.ts. Amp does not document its tool names,
// but its plugin API names the files a call modifies (`amp.helpers.filesModifiedByToolCall`) and the command a shell
// call runs (`amp.helpers.shellCommandFromToolCall`). The plugin sends those as `paths` and `command`, so the table is
// empty and the new text comes from the raw arguments when they hold it.
import { defineAdapter } from '../adapter.js';
import { installPluginFile, uninstallPluginFile, type PluginFileSpec } from '../plugin-file.js';
import { PLUGIN_NEUTRAL, pluginHandlers, type ToolTable } from '../plugin-protocol.js';
import { ampPlugin } from '../plugins/sources.js';

export const AMP_TOOLS: ToolTable = { shell: [], edit: [], patch: [] };

export const AMP_PLUGIN_FILE: Omit<PluginFileSpec, 'content'> = {
  title: 'Amp',
  dir: '.amp/plugins',
  name: 'slopbuckets.ts',
  altName: 'slopbuckets-hooks.ts',
};

export const ampAdapter = defineAdapter({
  name: 'amp',
  title: 'Amp',
  markers: ['.amp'],
  hookFiles: [],
  handlers: pluginHandlers(AMP_TOOLS, 'pre-edit', 'pre-tool', 'stop', 'subagent-stop'),
  neutral: { 'pre-edit': PLUGIN_NEUTRAL, 'pre-tool': PLUGIN_NEUTRAL, stop: PLUGIN_NEUTRAL, 'subagent-stop': PLUGIN_NEUTRAL },
  install: (projectDir, options) => [installPluginFile(projectDir, { ...AMP_PLUGIN_FILE, content: ampPlugin(options.command) })],
  uninstall: (projectDir) => uninstallPluginFile(projectDir, AMP_PLUGIN_FILE),
});

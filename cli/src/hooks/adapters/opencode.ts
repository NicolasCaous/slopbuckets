// The OpenCode adapter. OpenCode has no shell hooks, so `install` writes a plugin into .opencode/plugins/ that serves
// both API lines, and the plugin calls `buckets hook --agent opencode <event>` with the protocol of
// ../plugin-protocol.ts. The table covers both lines: V1 (`opencode-ai`) has edit and write with `filePath`,
// apply_patch with `patchText` and bash; V2 (`@opencode/cli`) has edit and write with `path`, patch and shell.
import { defineAdapter } from '../adapter.js';
import { installPluginFile, uninstallPluginFile, type PluginFileSpec } from '../plugin-file.js';
import { PLUGIN_NEUTRAL, pluginHandlers, type ToolTable } from '../plugin-protocol.js';
import { opencodePlugin } from '../plugins/sources.js';

/** OpenCode's edit writes newString as the whole file when oldString is empty. */
export const OPENCODE_TOOLS: ToolTable = { shell: ['bash', 'shell'], edit: ['edit', 'write'], patch: ['apply_patch', 'patch'], emptyOld: 'whole' };

export const OPENCODE_PLUGIN_FILE: Omit<PluginFileSpec, 'content'> = {
  title: 'OpenCode',
  dir: '.opencode/plugins',
  name: 'slopbuckets.ts',
  altName: 'slopbuckets-hooks.ts',
};

export const opencodeAdapter = defineAdapter({
  name: 'opencode',
  title: 'OpenCode',
  markers: ['.opencode', 'opencode.json', 'opencode.jsonc'],
  hookFiles: [],
  handlers: pluginHandlers(OPENCODE_TOOLS, 'pre-edit', 'pre-tool', 'stop', 'subagent-stop', 'post-compact'),
  neutral: { 'pre-edit': PLUGIN_NEUTRAL, 'pre-tool': PLUGIN_NEUTRAL, stop: PLUGIN_NEUTRAL, 'subagent-stop': PLUGIN_NEUTRAL, 'post-compact': PLUGIN_NEUTRAL },
  install: (projectDir, options) => [installPluginFile(projectDir, { ...OPENCODE_PLUGIN_FILE, content: opencodePlugin(options.command) })],
  uninstall: (projectDir) => uninstallPluginFile(projectDir, OPENCODE_PLUGIN_FILE),
});

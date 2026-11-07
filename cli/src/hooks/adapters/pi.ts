// The Pi adapter. Pi loads extensions, not shell hooks, so `install` writes .pi/extensions/slopbuckets.ts, which calls
// `buckets hook --agent pi <event>` with the protocol of ../plugin-protocol.ts. Pi's tools: bash and powershell run
// `command`; edit (`path`, `edits[]`) and write (`path`, `content`) change one file. Pi has no patch tool and no
// subagents.
import { defineAdapter } from '../adapter.js';
import { installPluginFile, uninstallPluginFile, type PluginFileSpec } from '../plugin-file.js';
import { PLUGIN_NEUTRAL, pluginHandlers, type ToolTable } from '../plugin-protocol.js';
import { piPlugin } from '../plugins/sources.js';

export const PI_TOOLS: ToolTable = { shell: ['bash', 'powershell'], edit: ['edit', 'write'], patch: [] };

export const PI_PLUGIN_FILE: Omit<PluginFileSpec, 'content'> = {
  title: 'Pi',
  dir: '.pi/extensions',
  name: 'slopbuckets.ts',
  altName: 'slopbuckets-hooks.ts',
};

export const piAdapter = defineAdapter({
  name: 'pi',
  title: 'Pi',
  markers: ['.pi'],
  handlers: pluginHandlers(PI_TOOLS, 'pre-edit', 'pre-tool', 'stop', 'post-compact'),
  neutral: { 'pre-edit': PLUGIN_NEUTRAL, 'pre-tool': PLUGIN_NEUTRAL, stop: PLUGIN_NEUTRAL, 'post-compact': PLUGIN_NEUTRAL },
  install: (projectDir, options) => {
    const step = installPluginFile(projectDir, { ...PI_PLUGIN_FILE, content: piPlugin(options.command) });
    if (step.status === 'failed') return [step];
    return [
      step,
      {
        status: 'todo',
        text: 'Pi loads project extensions only in a trusted project: answer yes to the trust prompt when Pi starts in this folder, or run /trust, and use --approve for print or JSON runs',
      },
    ];
  },
  uninstall: (projectDir) => uninstallPluginFile(projectDir, PI_PLUGIN_FILE),
});

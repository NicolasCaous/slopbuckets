// The Pi adapter. Pi loads extensions, not shell hooks, so `install` writes .pi/extensions/slopbuckets.ts, which calls
// `buckets hook --agent pi <event>` with the normalized protocol of ../plugin-protocol.ts. Pi's tools: bash and
// powershell run `command`; edit and write change `path`. Pi has no patch tool and no subagents.
import type { HookAdapter } from '../adapter.js';
import { installPluginFile, uninstallPluginFile, type PluginFileSpec } from '../plugin-file.js';
import { LOWERCASE_READ_DENY_REASON, NO_TOOL_CALL, pathArg, runPluginHook, type PluginInput, type PluginToolCall } from '../plugin-protocol.js';
import { PI_PLUGIN } from '../plugins/pi.js';

export const PI_EVENTS = ['pre-tool-use', 'post-tool-use', 'stop'] as const;

/** The core action of a Pi tool call. */
export function piToolCall(input: PluginInput): PluginToolCall {
  const { tool, args } = input;
  if (tool === 'edit' || tool === 'write') {
    const file = pathArg(args, 'path');
    const paths = file === undefined ? [] : [file];
    return { action: { kind: 'write', paths }, edited: paths };
  }
  if (tool === 'bash' || tool === 'powershell') {
    return { action: { kind: 'shell', command: typeof args.command === 'string' ? args.command : '' }, edited: [] };
  }
  return NO_TOOL_CALL;
}

export const PI_PLUGIN_FILE: PluginFileSpec = {
  title: 'Pi',
  dir: '.pi/extensions',
  name: 'slopbuckets.ts',
  altName: 'slopbuckets-hooks.ts',
  content: PI_PLUGIN,
};

export const piAdapter: HookAdapter = {
  name: 'pi',
  title: 'Pi',
  markers: ['.pi'],
  events: PI_EVENTS,
  run: (ctx, io, event) => runPluginHook(ctx, io, event, piToolCall, { denyReason: LOWERCASE_READ_DENY_REASON }),
  install: (projectDir) => {
    const step = installPluginFile(projectDir, PI_PLUGIN_FILE);
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
};

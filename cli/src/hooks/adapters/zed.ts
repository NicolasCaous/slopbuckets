// The Zed adapter. Zed's own agent has no hooks. Its only static guard is `agent.tool_permissions`, regular
// expressions that deny a terminal command or a file tool by its text, and Zed reads `agent` settings only from the
// user settings file, not from a project's `.zed/settings.json`. So install writes nothing and points to the snippet in
// the docs. Claude Code running inside Zed through ACP keeps its own hooks from `.claude/settings.json`.
import type { HookAdapter, InstallStep } from '../adapter.js';
import { noHooksRun } from './no-hooks.js';

const TITLE = 'Zed';

/** A plain `buckets refresh`: no flag after it, or a first argument that is not exactly `--web`, or a flag after `--web`. */
export const ZED_REFRESH_PATTERN =
  "buckets(?:\\.cmd|\\.exe)?['\"]?\\s+(?:--?[\\w-]+\\s+)*refresh(?:\\s*$|\\s+(?:[^-\\s]|-[^-]|--[^w]|--w[^e]|--we[^b]|--web\\S|--web\\s+-))";
/** The lock under its own name, or a Windows 8.3 short name such as `BUCKET~1.JSO`. */
export const ZED_LOCK_PATTERN = 'buckets\\.lock\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso';

const deny = (patterns: string[]) => ({ always_deny: patterns.map((pattern) => ({ pattern })) });

/** The user settings snippet the Zed page of the docs shows. */
export const ZED_TOOL_PERMISSIONS = {
  agent: {
    tool_permissions: {
      tools: {
        terminal: deny([ZED_LOCK_PATTERN, ZED_REFRESH_PATTERN]),
        edit_file: deny([ZED_LOCK_PATTERN]),
        write_file: deny([ZED_LOCK_PATTERN]),
        delete_path: deny([ZED_LOCK_PATTERN]),
        move_path: deny([ZED_LOCK_PATTERN]),
        copy_path: deny([ZED_LOCK_PATTERN]),
      },
    },
  },
};

function install(): InstallStep[] {
  return [
    {
      status: 'todo',
      text: 'Zed has no hooks, and it reads agent tool permissions only from your user settings, so slopbuckets wrote nothing for it. Copy the agent.tool_permissions rules from https://nicolascaous.github.io/slopbuckets/guide/agents/zed into your Zed user settings, and run `buckets init --git-hook`.',
    },
  ];
}

export const zedAdapter: HookAdapter = {
  name: 'zed',
  title: TITLE,
  markers: ['.zed'],
  events: [],
  run: noHooksRun(TITLE),
  install,
  uninstall: () => [],
};

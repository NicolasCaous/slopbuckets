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
/** One shell word: no whitespace and no command separator. */
const ZED_WORD = String.raw`[^\s;&|]`;
/** A word that is not exactly `--check` or `--json`, spelled out letter by letter, because Rust regex has no look-ahead. */
const ZED_NOT_REPORT_FLAG =
  String.raw`(?:[^-\s;&|]${ZED_WORD}*|-(?:[^-\s;&|]${ZED_WORD}*)?|--(?:[^cj\s;&|]${ZED_WORD}*` +
  String.raw`|c(?:[^h\s;&|]${ZED_WORD}*|h(?:[^e\s;&|]${ZED_WORD}*|e(?:[^c\s;&|]${ZED_WORD}*|c(?:[^k\s;&|]${ZED_WORD}*|k${ZED_WORD}+)?)?)?)?` +
  String.raw`|j(?:[^s\s;&|]${ZED_WORD}*|s(?:[^o\s;&|]${ZED_WORD}*|o(?:[^n\s;&|]${ZED_WORD}*|n${ZED_WORD}+)?)?)?)?)`;
/** A `buckets update` that can install: no word after `update`, up to the end of the command, is `--check` or `--json`. */
export const ZED_UPDATE_PATTERN = String.raw`buckets(?:\.cmd|\.exe)?['"]?\s+(?:--?[\w-]+\s+)*update(?:\s+${ZED_NOT_REPORT_FLAG})*\s*(?:$|[;&|])`;
/** The lock or the config under its own name, or a Windows 8.3 short name such as `BUCKET~1.JSO`. */
export const ZED_GUARDED_PATTERN = 'buckets\\.(?:lock|config)\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso';

const deny = (patterns: string[]) => ({ always_deny: patterns.map((pattern) => ({ pattern })) });

/** The user settings snippet the Zed page of the docs shows. */
export const ZED_TOOL_PERMISSIONS = {
  agent: {
    tool_permissions: {
      tools: {
        terminal: deny([ZED_GUARDED_PATTERN, ZED_REFRESH_PATTERN, ZED_UPDATE_PATTERN]),
        edit_file: deny([ZED_GUARDED_PATTERN]),
        write_file: deny([ZED_GUARDED_PATTERN]),
        delete_path: deny([ZED_GUARDED_PATTERN]),
        move_path: deny([ZED_GUARDED_PATTERN]),
        copy_path: deny([ZED_GUARDED_PATTERN]),
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

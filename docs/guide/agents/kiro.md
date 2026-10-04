---
title: Kiro
description: The preToolUse hook that buckets init installs for Kiro CLI and the Kiro IDE, and why it does not block on Windows.
---

# Kiro

This page covers Kiro CLI 2.x agent hooks, Kiro CLI 3 and the Kiro IDE.

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | partial | `preToolUse` exits with code 2 and Kiro skips the tool, except in kiro-cli on Windows |
| Feedback after edits | no | Kiro's `postToolUse` cannot hand a report back to the model |
| Block the end of a turn | no | Kiro's `stop` cannot keep the agent working |

## Install

```sh
buckets init --agent kiro
```

It writes:

- `.kiro/hooks/slopbuckets.json`, a standalone hook file in the `v1` format with one `PreToolUse` hook, which Kiro CLI 3 and the Kiro IDE read
- a `preToolUse` entry in `hooks` of each agent config in `.kiro/agents/*.json`, which Kiro CLI 2.x reads
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Kiro CLI 2.x reads hooks only from the agent you run. When `.kiro/agents/` has no config, `init` says so: add the entry below to the agent you use, or run `buckets init --agent kiro` again after you create it.

```json
{
  "hooks": {
    "preToolUse": [{ "command": "buckets hook --agent kiro pre-tool-use", "timeout_ms": 60000 }]
  }
}
```

Kiro CLI 3 reads both the standalone file and the hooks inside agent configs, so the hook may run twice for one call there. Both runs give the same answer.

## How it works

Before each tool call, Kiro runs `buckets hook --agent kiro pre-tool-use` with `tool_name`, `tool_input` and `cwd` on stdin. The hook has no matcher, because Kiro names its tools differently across versions (`fs_write`, `write`, `str_replace`, `fs_append`, `delete_file`, `execute_bash`, `execute_pwsh`, `shell`), so it sees every tool and ignores the ones that neither write nor run a command. It reads the target from `path`, `file_path`, `targetFile`, `paths` and `operations[].path`.

When a call would write any `buckets.lock.json`, or a command names the lock or runs `buckets refresh` with anything but exactly `--web`, the hook writes the reason on stderr and exits with code 2. Kiro blocks the tool and hands the reason to the model. Otherwise it exits with 0 and prints nothing.

## Limits

- In kiro-cli on Windows, a hook that exits with code 2 does not block the tool call ([kirodotdev/Kiro#8264](https://github.com/kirodotdev/Kiro/issues/8264)). The hook runs, but the write or the command goes on. On Windows, treat the Kiro hook as a warning only.
- `postToolUse` and `stop` cannot feed a report back or keep the agent working, so slopbuckets installs neither. Nothing reports problems after an edit, and nothing runs `buckets check` before the agent ends its turn.
- The hook fails open, like every slopbuckets integration. When the `buckets` command is missing, or the hook crashes, Kiro shows a warning and runs the tool.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). On Windows they are the only real guard.

## Check that it works

1. Start `kiro-cli chat` in the project, with the agent that has the hook if you use Kiro CLI 2.x.
2. Ask it to "run buckets refresh". On macOS and Linux, Kiro should report that a hook blocked the command, with the slopbuckets reason.
3. Ask it to "add an empty line to buckets.lock.json". The write should be blocked the same way.

By hand, from the project folder:

```sh
echo '{"hook_event_name":"preToolUse","cwd":"'"$PWD"'","tool_name":"execute_bash","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent kiro pre-tool-use; echo "exit $?"
```

It prints the reason and `exit 2`.

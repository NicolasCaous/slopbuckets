---
title: Crush
description: The PreToolUse hook that buckets init adds to .crush.json for Crush.
---

# Crush

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `PreToolUse` answers `deny` before the permission prompt |
| Feedback after edits | no | Crush has no hook after a tool call |
| Block the end of a turn | no | Crush has no hook at the end of a turn |

## Install

```sh
buckets init --agent crush
```

It adds one hook and writes the shared instructions:

- an entry in `hooks.PreToolUse` of `.crush.json`, or of `crush.json` when that is the file the project already has
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Your own hooks, settings and comments stay as they were. Crush reads the hook when it starts, with no switch to turn on.

## How it works

Before a call to `bash`, `edit`, `multiedit`, `write` or `download`, Crush runs `buckets hook --agent crush pre-tool-use` with `tool_name`, `tool_input` and `cwd` on stdin. The session folder is `CRUSH_PROJECT_DIR`. When a file tool's `file_path` is any `buckets.lock.json` or `buckets.config.json`, or a `bash` command names either file or runs `buckets refresh` with anything but exactly `--web` or `buckets update` without `--check` or `--json`, the hook prints `{"decision": "deny", "reason": "..."}`. Crush blocks the call before its permission prompt and shows the reason to the model.

For every other call the hook prints nothing. It never answers `allow`, because Crush takes that as approval and skips its permission prompt.

## Limits

- After an edit, nothing reports the problems in the file.
- Nothing runs `buckets check` before the agent ends its turn.
- Crush runs hooks only for the top-level agent. Calls made by a sub-agent, such as through the `agent` tool, are not checked.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or the hook fails or times out, Crush lets the call through and no check runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start `crush` in the project.
2. Ask it to "run buckets refresh". Crush should show that a hook denied the command, with the slopbuckets reason.
3. Ask it to "add an empty line to buckets.lock.json". The write should be denied the same way.

By hand, from the project folder:

```sh
echo '{"event":"PreToolUse","cwd":"'"$PWD"'","tool_name":"bash","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent crush pre-tool-use
```

It prints `{"decision":"deny",...}`.

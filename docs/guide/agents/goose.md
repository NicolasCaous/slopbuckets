---
title: Goose
description: The plugin hooks that buckets init writes in .agents/plugins/slopbuckets/ for Goose.
---

# Goose

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `PreToolUse` answers `block`, and Goose refuses the call |
| Feedback after edits | no | Goose has no hook after an edit that can talk to the model |
| Block the end of a turn | yes | `Stop` answers `block` once with the `buckets check` report |

## Install

```sh
buckets init --agent goose
```

It writes a project plugin and the shared instructions:

- `.agents/plugins/slopbuckets/hooks/hooks.json` with a `PreToolUse` hook and a `Stop` hook
- `.agents/plugins/slopbuckets/plugin.json`, the plugin manifest
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Goose finds project plugins in `.agents/plugins/` when a session starts and turns new ones on by itself. If you disabled the plugin before, remove `slopbuckets` from `disabledPlugins` in `.config/goose/settings.json`.

Running `init` again updates the slopbuckets entries in `hooks.json` and leaves your own hooks there alone. An install from an older version had `on_failure: "block"` on the `PreToolUse` hook, and `init` removes it.

Goose runs hook commands with `sh -c`, also on Windows, so Windows needs `sh` on the PATH. Git for Windows has one.

## How it works

Before a tool whose name ends in `shell`, `write`, `edit` or `text_editor` runs, Goose runs `buckets hook --agent goose pre-tool-use` with `tool_name`, `tool_input` and `working_dir` on stdin. When a `write` or `edit` targets any `buckets.lock.json` or `buckets.config.json`, or a `shell` command names either file or runs `buckets refresh` with anything but exactly `--web` or `buckets update` without `--check` or `--json`, the hook prints `{"decision": "block", "reason": "..."}`. Goose refuses the call and tells the model not to retry it. For every other call the hook prints nothing and exits with 0, which Goose reads as allow.

The hook keeps Goose's default `on_failure: "allow"`, so a hook that fails or times out lets the call through. slopbuckets never blocks the agent because the hook itself broke.

When the agent is about to end its turn, Goose runs `buckets hook --agent goose stop`. The hook runs `buckets check` with nested projects. When it fails, the hook prints `{"decision": "block", "reason": "<report>"}`, and Goose hands the report to the model and keeps it working. Goose sends no `stop_hook_active` flag, so the hook leaves a small mark in the system temp folder and lets the next stop of the same session through. It never blocks twice in a row.

## Limits

- After an edit, nothing reports the problems in the file. The model hears about them at the end of the turn.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook fails or times out, Goose lets the call through and lets the turn end without a check.
- Goose does not run hooks for the tool calls of subagents.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start a Goose session in the project.
2. Ask it to "run buckets refresh". Goose should say a policy hook from `slopbuckets` denied the call.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder and stop. Before it finishes, Goose should get the `buckets check` report and fix the import.

By hand, from the project folder:

```sh
echo '{"event":"PreToolUse","session_id":"s1","tool_name":"shell","tool_input":{"command":"buckets refresh"},"working_dir":"'"$PWD"'"}' | buckets hook --agent goose pre-tool-use
```

It prints `{"decision":"block",...}`.

---
title: Cursor
description: The hooks that buckets init writes in .cursor/hooks.json for the Cursor editor and the cursor-agent CLI.
---

# Cursor

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `preToolUse` denies a `Write` or `Delete` of a lock or a config, and `beforeShellExecution` denies a command that names one or runs plain `buckets refresh` or an installing `buckets update` |
| Feedback after edits | partial | `postToolUse` returns the `buckets check --file` report, but whether the model sees it depends on the Cursor version |
| Block the end of a turn | yes | `stop` sends the `buckets check` report as a follow-up message, once per turn |

## Install

```sh
buckets init --agent cursor
```

It writes:

- `.cursor/hooks.json` with `preToolUse`, `beforeShellExecution`, `postToolUse`, `stop` and `subagentStop` hooks. Each one runs `buckets hook --agent cursor <event>`. If the file already exists, `init` keeps your hooks and adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Cursor reads

Cursor runs the commands from the project folder and needs no approval step. Restart Cursor, or start a new `cursor-agent` session, after `init` so it loads the new file.

Cursor also runs the hooks in `.claude/settings.json` by default. If you install both `claude` and `cursor`, each check runs twice in Cursor. Both give the same answers.

## How it works

- `preToolUse`, with the matcher `Write|Delete`. Cursor maps its edit tools to `Write`. When the target is any `buckets.lock.json` or `buckets.config.json`, also as a Windows path, with a stream suffix or with a trailing dot, the hook prints `{"permission": "deny", "agent_message": "<reason>", "user_message": "..."}`. Every other call gets an explicit `{"permission": "allow"}`.
- `beforeShellExecution`. When the command names either file or runs `buckets refresh` with anything but exactly `--web` or `buckets update` without `--check` or `--json`, the hook denies it the same way. Every other command gets `{"permission": "allow"}`.
- A `.cursor/hooks.json` from an older slopbuckets version had `failClosed: true` on the two guards, which made Cursor refuse the call when the hook could not run. `buckets init --agent cursor` removes it from those entries and leaves `failClosed` on your own hooks alone.
- `postToolUse`, with the matcher `Write`. The hook runs `buckets check --file` on the written file and returns the report in `additional_context`.
- `stop`, with `loop_limit: 1`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"followup_message": "<report>"}`, which Cursor sends as the next user message, so the agent keeps working. It answers only when `loop_count` is 0, the first stop of the turn, and never when you stopped the turn yourself.
- `subagentStop` works the same way for a subagent. Its payload has no loop count, so the hook leaves a small mark in the system temp folder and lets the next stop of the same subagent through. It never blocks twice in a row.

Cursor writes workspace roots on Windows as `/c:/Users/...`. The hook turns them back into Windows paths.

## Limits

- `preToolUse` needs Cursor 2.4 or later. Older versions run only `beforeShellExecution`, so they block plain `buckets refresh` but not a write to the lock or the config.
- The arguments of the `Write` tool are not documented. The hook reads the path from `file_path`, `path` and the other usual names. This was not checked against a real Cursor payload.
- Some Cursor versions do not hand `additional_context` to the model. Then the model hears about problems in an edited file only from the stop report.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook crashes or times out, Cursor lets the call through and no check runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Restart Cursor in the project.
2. Ask the agent to "run buckets refresh". Cursor should show that a hook blocked the command.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder and finish. At the end of the turn, a follow-up message with the `buckets check` report should appear, and the agent should fix the import.

By hand, from the project folder:

```sh
echo '{"hook_event_name":"beforeShellExecution","command":"buckets refresh","cwd":"'"$PWD"'","workspace_roots":["'"$PWD"'"]}' | buckets hook --agent cursor before-shell-execution
```

It prints `{"permission":"deny",...}`.

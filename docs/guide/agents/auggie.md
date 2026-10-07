---
title: Auggie
description: The hooks that buckets init writes in .augment/settings.json for Auggie, the Augment CLI.
---

# Auggie

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `PreToolUse` denies `save-file`, `str-replace-editor` and `remove-files` on a lock or a config and a `launch-process` command that names one or runs plain `buckets refresh` or an installing `buckets update` |
| Feedback after edits | yes | `PostToolUse` hands the `buckets check --file` report to the agent after each edit |
| Block the end of a turn | yes | `Stop` blocks once with the `buckets check` report |

## Install

```sh
buckets init --agent auggie
```

It writes:

- the `hooks` key of `.augment/settings.json`, with a `PreToolUse`, a `PostToolUse` and a `Stop` hook. Each one runs `buckets hook --agent auggie <event>`. Settings you already have stay as they are, comments included, and `init` adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Start a new `auggie` session after `init` so it loads the settings.

## How it works

Auggie sends Claude Code style JSON on stdin, with `conversation_id` and `workspace_roots`. The hook takes the session folder from the first workspace root.

- `PreToolUse`, with the matcher `launch-process|save-file|str-replace-editor|remove-files`. When a path argument names any `buckets.lock.json` or `buckets.config.json`, also as a Windows path, with a stream suffix or with a trailing dot, or when the command names either file or runs `buckets refresh` with anything but exactly `--web` or `buckets update` without `--check` or `--json`, the hook prints `{"hookSpecificOutput": {"permissionDecision": "deny", ...}}`, writes the reason on stderr and exits with 2. A `str-replace-editor` call with the `view` command only reads, so it passes.
- `PostToolUse`, with the matcher `save-file|str-replace-editor`. The hook runs `buckets check --file` on the edited file and prints `{"decision": "block", "reason": "<report>"}`.
- `Stop`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"decision": "block", "reason": "<report>"}` and the agent keeps working. When the payload carries `stop_hook_active: true`, the hook lets the stop through. When it carries no such flag, the hook leaves a small mark in the system temp folder and lets the next stop of the same conversation through. It never blocks twice in a row.

## Limits

- The argument names of Auggie's tools are not documented. The hook reads paths from `path`, `file_path`, `file_paths` and the other usual names, and commands from `command`. This was not checked against a real Auggie payload.
- Whether Auggie reads the `decision: "block"` answer after an edit, and whether its stop payload has `stop_hook_active`, was not verified.
- Auggie has no event for the end of a subagent's work.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook crashes or times out, Auggie lets the call through and no check runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start `auggie` in the project.
2. Ask it to "run buckets refresh". The command should be blocked with the slopbuckets reason.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. After the edit, Auggie should see the `buckets check --file` report and fix the import.

By hand, from the project folder:

```sh
echo '{"workspace_roots":["'"$PWD"'"],"hook_event_name":"PreToolUse","tool_name":"launch-process","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent auggie pre-tool-use; echo "exit $?"
```

It prints the deny JSON, the reason and `exit 2`.

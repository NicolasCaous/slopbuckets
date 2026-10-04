---
title: Qwen Code
description: The hooks that buckets init writes in .qwen/settings.json for Qwen Code.
---

# Qwen Code

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `PreToolUse` denies `write_file` and `edit` on a lock and a `run_shell_command` that names it or runs plain `buckets refresh` |
| Feedback after edits | yes | `PostToolUse` adds the `buckets check --file` report after the tool result |
| Block the end of a turn | yes | `Stop` and `SubagentStop` block once with the `buckets check` report |

## Install

```sh
buckets init --agent qwen
```

It writes:

- the `hooks` key of `.qwen/settings.json`, with a `PreToolUse`, a `PostToolUse`, a `Stop` and a `SubagentStop` hook. Each one runs `buckets hook --agent qwen <event>`. Settings you already have stay as they are, comments included, and `init` adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Start a new Qwen Code session after `init`. Run `/hooks` there to see the hooks it loaded.

Qwen Code reads `QWEN.md` for project instructions by default. To make it read the slopbuckets block too, add `AGENTS.md` to `context.fileName` in `.qwen/settings.json`, such as `"context": { "fileName": ["AGENTS.md", "QWEN.md"] }`.

## How it works

Qwen Code sends Claude Code style JSON on stdin, sets `QWEN_PROJECT_DIR` for every hook, and the hook takes the session folder from it.

- `PreToolUse`, with the matcher `write_file|edit|replace|run_shell_command`. When `file_path` names a lock, also as a Windows path, with a stream suffix or with a trailing dot, or when the command names the lock or runs `buckets refresh` with anything but exactly `--web`, the hook prints `{"hookSpecificOutput": {"permissionDecision": "deny", ...}}`, writes the reason on stderr and exits with 2. Qwen Code blocks the call on either signal. The Claude names `Write`, `Edit` and `Bash` work too.
- `PostToolUse`, with the matcher `write_file|edit|replace`. The hook runs `buckets check --file` on the edited file and returns the report in `hookSpecificOutput.additionalContext`.
- `Stop` and `SubagentStop`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"decision": "block", "reason": "<report>"}` and Qwen Code keeps working. The next stop carries `stop_hook_active: true`, and the hook lets it through, so it blocks once.

## Limits

- Qwen Code ends a turn after 8 blocked stops in a row. The hook blocks once, so it never reaches that cap.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook crashes or times out, Qwen Code lets the call through and no check runs.
- Whether Qwen Code ignores project settings in a folder you have not trusted, as Gemini CLI does, was not verified. If the hooks do not show in `/hooks`, trust the folder.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start `qwen` in the project and run `/hooks`. The four slopbuckets hooks should be listed.
2. Ask it to "run buckets refresh". The tool call should be blocked with the slopbuckets reason.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. After the edit, Qwen should see the `buckets check --file` report and fix the import.

By hand, from the project folder:

```sh
echo '{"cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"run_shell_command","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent qwen pre-tool-use; echo "exit $?"
```

It prints the deny JSON, the reason and `exit 2`.

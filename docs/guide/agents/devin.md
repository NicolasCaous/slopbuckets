---
title: Devin Desktop
description: The hooks that buckets init writes in .devin/hooks.v1.json for the Devin Local agent of Devin Desktop.
---

# Devin Desktop

This page covers Devin Local, the default agent of Devin Desktop. For Cascade, the older Windsurf agent, see [Windsurf](./windsurf).

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `PreToolUse` exits with 2 for a `write`, `edit`, `delete` or `move` of a lock and an `exec` command that names it or runs plain `buckets refresh` |
| Feedback after edits | partial | `PostToolUse` returns the `buckets check --file` report, but the answer format Devin reads after an edit was not verified |
| Block the end of a turn | yes | `Stop` blocks once with the `buckets check` report |

## Install

```sh
buckets init --agent devin
```

It writes:

- `.devin/hooks.v1.json` with a `PreToolUse`, a `PostToolUse` and a `Stop` hook. Each one runs `buckets hook --agent devin <event>`. If the file already exists, `init` keeps your hooks and adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Start a new Devin Local session after `init` so it loads the file.

Devin Local also reads the hooks in `.claude/settings.json`. Its tool names are lowercase (`read`, `write`, `edit`, `exec`), so the Claude Code matchers `Edit|Write|Bash` never match them, which is why this adapter has its own file. If you install both `claude` and `devin`, the Claude Code `Stop` hook also runs in Devin and the stop check runs twice. Both give the same answer.

## How it works

Devin Local sends Claude Code style JSON on stdin: `tool_name`, `tool_input`, `cwd` and, at a stop, `stop_hook_active`.

- `PreToolUse`, with the matcher `write|edit|exec|delete|move`. When a path argument names a lock, also as a Windows path, with a stream suffix or with a trailing dot, or when the command names the lock or runs `buckets refresh` with anything but exactly `--web`, the hook writes the reason on stderr, prints the Claude Code style deny JSON and exits with 2, which blocks the call.
- `PostToolUse`, with the matcher `write|edit`. The hook runs `buckets check --file` on the edited file and prints `{"decision": "block", "reason": "<report>"}`.
- `Stop`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"decision": "block", "reason": "<report>"}` and the agent keeps working. The next stop carries `stop_hook_active: true`, and the hook lets it through, so it blocks once.

## Limits

- The argument names of Devin's tools are not documented. The hook reads paths from `file_path`, `path`, `target_file`, `old_path`, `new_path` and the other usual names, and commands from `command` or `command_line`. This was not checked against a real Devin payload.
- Whether Devin reads the `decision: "block"` answer after an edit was not verified. The stop report still reaches the agent at the end of the turn.
- Devin Local has no event for the end of a subagent's work.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook crashes or times out, Devin lets the call through and no check runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start a Devin Local session in the project.
2. Ask it to "run buckets refresh". The command should be blocked with the slopbuckets reason.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder and finish. Before it finishes, Devin should get the `buckets check` report and fix the import.

By hand, from the project folder:

```sh
echo '{"cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"exec","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent devin pre-tool-use; echo "exit $?"
```

It prints the deny JSON, the reason and `exit 2`.

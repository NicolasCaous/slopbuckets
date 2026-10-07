---
title: Gemini CLI
description: The hooks that buckets init writes in .gemini/settings.json for Gemini CLI, and the folder trust they need.
---

# Gemini CLI

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `BeforeTool` denies `write_file` and `replace` on a lock or a config and a `run_shell_command` that names one or runs plain `buckets refresh` or an installing `buckets update`, also with `--yolo` |
| Feedback after edits | yes | `AfterTool` adds the `buckets check --file` report to the model's context after each edit |
| Block the end of a turn | yes | `AfterAgent` makes the agent retry once with the `buckets check` report |

## Install

```sh
buckets init --agent gemini
```

It writes:

- the `hooks` key of `.gemini/settings.json`, with a `BeforeTool`, an `AfterTool` and an `AfterAgent` hook. Each one runs `buckets hook --agent gemini <event>`. Settings you already have stay as they are, comments included, and `init` adds only the missing entries.
- `"context": { "fileName": ["AGENTS.md", "GEMINI.md"] }` in the same file, when you have not set `context.fileName`. Gemini CLI reads only `GEMINI.md` by default, and this makes it read the slopbuckets block in `AGENTS.md` too. If you set `context.fileName` yourself without `AGENTS.md`, `init` leaves it alone and asks you to add `AGENTS.md`.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Gemini CLI ignores project settings in a folder you have not trusted. When it asks whether you trust the project folder, trust it, or the hooks do not run.

To remove the hooks, delete the three slopbuckets entries under `hooks`. `context.fileName` can stay, since Gemini CLI then reads both files.

## How it works

Hook timeouts in Gemini CLI are in milliseconds. `init` gives the guard 30 seconds and the checks 5 and 10 minutes.

- `BeforeTool`, with the matcher `write_file|replace|run_shell_command`. When `file_path` is any `buckets.lock.json` or `buckets.config.json`, also as a Windows path, with a stream suffix or with a trailing dot, or when the command names either file or runs `buckets refresh` with anything but exactly `--web` or `buckets update` without `--check` or `--json`, the hook prints `{"decision": "deny", "reason": "<reason>"}`. The model sees a tool error with the reason and goes on. Every other call gets no output.
- `AfterTool`, with the matcher `write_file|replace`. The hook runs `buckets check --file` on the edited file and returns the report in `hookSpecificOutput.additionalContext`. It does not answer `decision: "deny"` there, because that would replace the tool result.
- `AfterAgent`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"decision": "deny", "reason": "<report>"}`, and Gemini CLI makes the agent retry with the report. The retry carries `stop_hook_active: true`, and the hook lets it through, so it blocks once.

## Limits

- Hooks are on by default since Gemini CLI v0.26.0.
- The hooks run only in a trusted folder.
- Gemini CLI has no event for the end of a subagent's work, so only the main agent's turn is checked.
- Gemini CLI may read output that is not JSON, with an exit code other than 0 or 1, as a deny. The hook always exits with 0 and prints JSON or nothing.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook crashes or times out, Gemini CLI lets the call through and no check runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start `gemini` in the project and trust the folder when it asks.
2. Ask it to "run buckets refresh". The tool call should fail with the slopbuckets reason.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. After the edit, Gemini should see the `buckets check --file` report and fix the import.

By hand, from the project folder:

```sh
echo '{"cwd":"'"$PWD"'","hook_event_name":"BeforeTool","tool_name":"run_shell_command","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent gemini before-tool
```

It prints `{"decision":"deny",...}`.

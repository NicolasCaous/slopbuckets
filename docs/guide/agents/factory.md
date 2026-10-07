---
title: Factory Droid
description: The hooks that buckets init writes in .factory/hooks.json for Factory Droid.
---

# Factory Droid

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `PreToolUse` denies `Create`, `Edit` and `ApplyPatch` on a lock or a config and an `Execute` command that names one or runs plain `buckets refresh` or an installing `buckets update` |
| Feedback after edits | yes | `PostToolUse` hands the `buckets check --file` report to Droid after each edit |
| Block the end of a turn | yes | `Stop` and `SubagentStop` block once with the `buckets check` report |

## Install

```sh
buckets init --agent factory
```

It writes:

- `.factory/hooks.json` with a `PreToolUse`, a `PostToolUse`, a `Stop` and a `SubagentStop` hook at the top level of the file. Each one runs `buckets hook --agent factory <event>`. If the file already exists, `init` keeps your hooks and adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Droid reads the project hooks when a session starts. Start a new session after `init`.

## How it works

Droid sends Claude Code style JSON on stdin: `session_id`, `cwd`, `tool_name`, `tool_input` and, at a stop, `stop_hook_active`. The hook takes the session folder from `FACTORY_PROJECT_DIR` when Droid sets it.

- `PreToolUse`, with the matcher `Execute|Create|Edit|MultiEdit|ApplyPatch`. When `file_path` names any `buckets.lock.json` or `buckets.config.json`, also as a Windows path, with a stream suffix or with a trailing dot, or a header of the `ApplyPatch` text does, the hook prints `{"hookSpecificOutput": {"permissionDecision": "deny", ...}}` with the reason. It does the same for an `Execute` command that names either file or runs `buckets refresh` with anything but exactly `--web` or `buckets update` without `--check` or `--json`.
- The hook never answers allow. In Droid, a hook that answers allow skips Droid's own permission prompts, so every other call gets no output and Droid asks you as usual.
- `PostToolUse`, with the matcher `Create|Edit|MultiEdit|ApplyPatch`. The hook runs `buckets check --file` on each edited file and prints `{"decision": "block", "reason": "<report>"}`, which Droid hands to the model.
- `Stop` and `SubagentStop`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"decision": "block", "reason": "<report>"}` and Droid keeps working. The next stop carries `stop_hook_active: true`, and the hook lets it through, so it blocks once.

## Limits

- Hooks need Droid v0.24.0 or later.
- Where `ApplyPatch` puts its patch text is not documented. The hook reads it from `tool_input` as a string and from `tool_input.patch`.
- The path argument of `Edit` may be `file_path` or another name. The hook reads all the usual names.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook crashes or times out, Droid lets the call through and no check runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start `droid` in the project.
2. Ask it to "run buckets refresh". Droid should report that a hook denied the command, with the slopbuckets reason.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. After the edit, Droid should see the `buckets check --file` report and fix the import.

By hand, from the project folder:

```sh
echo '{"cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Execute","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent factory pre-tool-use
```

It prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}`.

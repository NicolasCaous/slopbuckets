---
title: Codex CLI
description: The hooks that buckets init writes in .codex/hooks.json for Codex CLI, and the approval Codex asks for before it runs them.
---

# Codex CLI

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `PreToolUse` denies an `apply_patch` that touches a lock or a config and a `Bash` command that names one or runs plain `buckets refresh` or an installing `buckets update`, also with `--yolo` |
| Feedback after edits | yes | `PostToolUse` adds the `buckets check --file` report to the model's context after each patch |
| Block the end of a turn | yes | `Stop` and `SubagentStop` block once with the `buckets check` report |

## Install

```sh
buckets init --agent codex
```

It writes:

- `.codex/hooks.json` with a `PreToolUse`, a `PostToolUse`, a `Stop` and a `SubagentStop` hook. Each one runs `buckets hook --agent codex <event>`. If the file already exists, `init` keeps your hooks and adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Codex reads

Codex runs project hooks only after two steps in Codex itself:

1. Trust the project when Codex asks, the first time you open it there.
2. Run `/hooks` and approve each slopbuckets hook.

Until you approve them, the hooks do not run and nothing is blocked. Codex keys an approval on the event, the matcher and the command, so you approve again only when a later `buckets init` changes one of them. `buckets init` reminds you of this step after it writes the file.

To remove the hooks, delete their entries from `.codex/hooks.json`, or delete the file if it holds nothing else.

## How it works

Codex sends each tool call to the hook as JSON on stdin. File edits arrive as `apply_patch`, with the patch text in `tool_input.command` and no file path, so the hook reads the paths from the patch headers `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:`. Shell commands arrive as `Bash`.

- `PreToolUse`, with the matcher `Bash|apply_patch|Edit|Write`. When a patch header names any `buckets.lock.json` or `buckets.config.json`, also as a Windows path, with a stream suffix or with a trailing dot, the hook denies the call. It does the same when a command names either file or runs `buckets refresh` with anything but exactly `--web` or `buckets update` without `--check` or `--json`. The answer is `permissionDecision: "deny"` with the full reason. Codex lets a deny without a reason through, so the reason is never empty.
- `PostToolUse`, with the matcher `apply_patch|Edit|Write`. The hook runs `buckets check --file` on each file the patch added, updated or moved to, and returns the report in `additionalContext`. It does not answer `decision: "block"`, because in Codex that replaces the tool output. Codex keeps about 2500 tokens of added context, so a longer report is cut and ends with a note to run the check by hand.
- `Stop` and `SubagentStop`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"decision": "block", "reason": "<report>"}` and Codex keeps working. The next stop carries `stop_hook_active: true`, and the hook lets it through, so it blocks once.

## Limits

- Hooks need Codex CLI 0.124.0 or later.
- The hooks run only in a trusted project, after you approve them in `/hooks`. A teammate who clones the project approves them again on their machine.
- On Windows, Codex runs hook commands through `cmd.exe`, which finds the `buckets.cmd` that npm installs.
- The deny holds under `--yolo`.
- The hooks fail open, like every slopbuckets integration. When the `buckets` command is missing, or a hook crashes or times out, Codex lets the call through and no check runs. The guard does no checking work, so it stays far below its 60 second timeout.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Open Codex in the project, trust it and approve the slopbuckets hooks in `/hooks`.
2. Ask Codex to "run buckets refresh". Codex should report that a hook denied the command, with the slopbuckets reason.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. After the patch, Codex should see the `buckets check --file` report and fix the import.

By hand, from the project folder:

```sh
echo '{"cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"buckets refresh"}}' | buckets hook --agent codex pre-tool-use
```

It prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}`.

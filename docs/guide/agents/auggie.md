---
title: Auggie
description: The hooks that buckets init writes in .augment/settings.json for Auggie, the Augment CLI.
---

# Auggie

This page covers Auggie, the Augment CLI, npm package `@augmentcode/auggie`.

| Phase | Support | How |
|---|---|---|
| Warning on edit | after the edit | `PostToolUse` returns the pending list in `additionalContext` |
| Pending list on other tools | after the tool | the same `PostToolUse` hook, which has no matcher, returns the current pending list |
| Interrupt on an invalid config | yes | `PreToolUse` on `save-file`, `str-replace-editor` and `remove-files` answers `permissionDecision: "deny"` |
| Interrupt at the end | yes | `Stop` answers `decision: "block"` once, when the turn ended normally |
| Subagents | no | Auggie has no subagent events |
| Compaction | no | Auggie has no compaction events |

## Install

```sh
buckets init --agent auggie
```

It writes:

- the `hooks` key of `.augment/settings.json` with three hooks whose `command` is `buckets hook --agent auggie <event> || exit 0`: `PreToolUse` with the matcher `save-file|str-replace-editor|remove-files`, `PostToolUse` with no matcher, and `Stop`. Every hook has a timeout in milliseconds: 60,000 for the tool hooks and 600,000 for `Stop`. If the file already exists, `init` keeps your settings and adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Auggie runs `command` through the system shell, `/bin/sh` on macOS and Linux and `cmd.exe` on Windows. Both shells read `|| exit 0` the same way, so `init` writes the same settings on every system, and a machine without the `buckets` command exits 0. The shell still prints that it cannot find `buckets` on stderr.

`init` replaces the 1.x entries, which ran `buckets hook --agent auggie <event>` without `|| exit 0`.

## How it works

Auggie sends each event to the hook as JSON on stdin, with `conversation_id`, `workspace_roots`, `tool_name` and `tool_input`. The hook uses `AUGMENT_PROJECT_DIR` as the project folder when it is set, else the first workspace root.

- `PreToolUse` with the matcher `save-file|str-replace-editor|remove-files` sees the edit before it runs. Auggie reads only a deny from it, so the hook uses it to refuse an edit that makes `buckets.config.json` worse, with `permissionDecision: "deny"`, and prints nothing otherwise. `str-replace-editor` carries `path` and numbered pairs such as `old_str_1` and `new_str_1`. `save-file` arguments are not documented. This hook keeps no memory, so nothing counts as shown before `PostToolUse` shows it.
- `PostToolUse` runs for every tool and delivers the warning in `hookSpecificOutput.additionalContext`. For the edit tools, its `file_changes` field carries the full new content of each file, and the hook checks that text. For every other tool, it shows the current pending list, and `launch-process` also marks the session as one that may have changed files.
- `Stop` runs the `stop` phase only when `agent_stop_cause` is `end_turn` or missing, not on an interrupt, an error or the iteration limit, and only when the conversation changed files or still has pending violations. Auggie has no loop flag, so the hook keeps a mark per conversation in `.buckets/sessions/` of the project to block once. It prints `decision` and `reason` both at the top level and inside `hookSpecificOutput`, until a test in a live session shows which one Auggie reads.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Auggie sets `AUGMENT_PROJECT_DIR`, but it runs hooks through `cmd.exe` on Windows and `/bin/sh` elsewhere, and no one way to write the variable works in both. If Auggie runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- Auggie does not implement `allow` on `PreToolUse` yet, so no output skips its approval.
- When the model sees `PostToolUse` context relative to the tool result is not documented.
- What Auggie does after a stop block is not described in its docs.
- Hooks run inside subagents since Auggie 0.30.0, but no event marks a subagent's end.
- Exit code 2 blocks only on `PreToolUse`. Other non-zero codes are non-blocking, so a crash lets the call through.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Start Auggie in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. After the edit, it should get the pending list with `billing -> payments: private file`.
3. Let it end the turn without a fix. `Stop` should block once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send the `PostToolUse` of the `save-file` that made it, then the stop of the same conversation:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"conversation_id":"test","workspace_roots":["'"$PWD"'"],"hook_event_name":"PostToolUse","tool_name":"save-file","tool_input":{"path":"src/billing/refund.ts"},"file_changes":[{"path":"src/billing/refund.ts","changeType":"create","content":"import { charge } from \"../payments/client\";\n"}]}' | buckets hook --agent auggie post-tool-use
echo '{"conversation_id":"test","workspace_roots":["'"$PWD"'"],"hook_event_name":"Stop","agent_stop_cause":"end_turn"}' | buckets hook --agent auggie stop
```

The first command prints `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"buckets: 1 pending. ..."}}`. The second prints the block with `buckets: 1 structure violation remains. ...` as the reason, and the same stop sent again prints nothing. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

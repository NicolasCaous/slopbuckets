---
title: Cursor
description: The hooks that buckets init writes in .cursor/hooks.json for Cursor, and why the warning arrives after the edit.
---

# Cursor

This page covers the Cursor editor and the `cursor-agent` CLI, which read the same hook file.

| Phase | Support | How |
|---|---|---|
| Warning on edit | after the edit | `postToolUse` returns the pending list in `additional_context`. Needs Cursor 3.9.8 or later |
| Pending list on other tools | after the tool | the same `postToolUse` hook, which has no matcher, returns the current pending list |
| Interrupt on an invalid config | yes | `preToolUse` on `Write` and `Delete` answers `permission: "deny"` with `agent_message` |
| Interrupt at the end | yes | `stop` answers `followup_message` once |
| Subagents | yes | `subagentStop` answers `followup_message` once, when the subagent completed |
| Compaction | no | Cursor has only `preCompact`, which runs before the compaction |

## Install

```sh
buckets init --agent cursor
```

It writes:

- `.cursor/hooks.json` with `"version": 1` and four hooks: `preToolUse` with the matcher `Write|Delete`, `postToolUse` with no matcher, `stop` and `subagentStop`, the last two with `loop_limit: 1`. Each one runs `buckets hook --agent cursor <event>`, with the events `pre-tool-use`, `post-tool-use`, `stop` and `subagent-stop`, and a timeout in seconds: 60 for the tool hooks and 600 for the stop hooks. If the file already exists, `init` keeps your hooks and adds only the missing entries. It also replaces the 1.x entries, such as `beforeShellExecution` and the `postToolUse` matcher.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Cursor runs `.cursor/hooks.json` in any trusted workspace and reloads it when the file changes.

## How it works

Cursor sends each event to the hook as JSON on stdin, with `conversation_id` and `workspace_roots`. The hook uses the first workspace root as the project folder.

- `preToolUse` with the matcher `Write|Delete` sees the edit before it runs. Cursor's `preToolUse` has no field that adds context and lets the tool run, so the hook only uses it to refuse an edit that makes `buckets.config.json` worse, with `permission: "deny"`, `agent_message` and `user_message`. For any other call it prints `{}`, never `{"permission": "allow"}`. This hook keeps no memory, so nothing counts as shown before `postToolUse` shows it.
- `postToolUse` runs for every tool and delivers the warning. For `Write`, the hook reads the file as it is on disk now and checks it as an edit. For `Delete`, the file is gone. For every other tool, it shows the current pending list, and a `Shell` call also marks the session as one that may have changed files. With pending violations, the hook prints `{"additional_context": "<pending list>"}`, which Cursor adds after the tool result.
- `stop` runs the `stop` phase, only when the session changed files or still has pending violations. With violations, the hook prints `{"followup_message": "<every violation in full>"}`, which Cursor submits as the next user message. It answers only when `loop_count` is 0 and `status` is not `aborted`.
- `subagentStop` runs the `subagent-stop` phase. It answers only when `loop_count` is 0 and `status` is `completed` or missing, and the follow-up continues the subagent.

Edits arrive as the `Write` tool, with `tool_input.file_path` and `tool_input.content`, the whole file on large edits. Cursor does not document these fields. They come from reports on its forum.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Cursor sets no variable with the project folder that the hook command could use. If Cursor runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- `postToolUse` `additional_context` reached the model only from Cursor 3.9.8. On older versions the warning is lost, and the stop hook and the git hook remain.
- Cursor honors only `deny` on `preToolUse` today, and an open ticket would make `allow` authoritative. The hook prints `{}` on every other call. The docs say an answer that does not match the schema blocks the action, and they do not say whether `{}` counts. This was not tested in a live session yet.
- Exit codes other than 0 and 2 fail open, so a missing `buckets` command lets every call through.
- Cursor has no event after compaction, so the memory of what was shown is never cleared.
- Whether tool hooks fire for tool calls inside a subagent is not documented.
- Cursor also loads the hooks in `.claude/settings.json` by default. The Claude Code hook prints nothing when the payload comes from Cursor, so the checks run once, through `.cursor/hooks.json`.
- On Windows, the desktop app runs hook commands through PowerShell. How `cursor-agent` runs them is not documented.

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Open the project in Cursor 3.9.8 or later.
2. Ask the agent to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. After the edit, the agent should get the pending list with `billing -> payments: private file`.
3. Let it end the turn without a fix. Cursor should submit the follow-up with `buckets: 1 structure violation remains.` once.

By hand, from the project folder, write a file with the violation, send the `postToolUse` of the `Write` that made it, then the stop of the same conversation:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"conversation_id":"test","workspace_roots":["'"$PWD"'"],"hook_event_name":"postToolUse","tool_name":"Write","tool_input":{"file_path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent cursor post-tool-use
echo '{"conversation_id":"test","workspace_roots":["'"$PWD"'"],"hook_event_name":"stop","status":"completed","loop_count":0}' | buckets hook --agent cursor stop
```

The first command prints `{"additional_context":"buckets: 1 pending. ..."}`. The second prints `{"followup_message":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

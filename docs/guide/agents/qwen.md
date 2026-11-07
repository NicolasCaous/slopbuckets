---
title: Qwen Code
description: The hooks that buckets init writes in .qwen/settings.json for Qwen Code, one per event.
---

# Qwen Code

| Phase | Support | How |
|---|---|---|
| Warning on edit | yes | `PreToolUse` simulates `write_file` and `edit` and returns the pending list in `additionalContext` |
| Pending list on other tools | yes | the same `PreToolUse` hook returns the current pending list for every other tool |
| Interrupt on an invalid config | yes | `PreToolUse` answers `permissionDecision: "deny"` |
| Interrupt at the end | yes | `Stop` answers `decision: "block"` once |
| Subagents | yes | `SubagentStop` does the same for the subagent |
| Compaction | yes | `PostCompact` clears the memory of what was shown |

## Install

```sh
buckets init --agent qwen
```

It writes:

- the `hooks` key of `.qwen/settings.json` with one entry each for `PreToolUse`, `Stop`, `SubagentStop` and `PostCompact`, none with a matcher. Each one runs `buckets hook --agent qwen <event>`, with the events `pre-tool-use`, `stop`, `subagent-stop` and `post-compact`, and every hook has a timeout in seconds: 60 for `PreToolUse`, 600 for the stop hooks and 30 for `PostCompact`. If the file already exists, `init` keeps your settings and adds only the missing entries. It also replaces the 1.x entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Qwen loads project hooks only in a trusted folder. Trust the folder when Qwen asks.

## How it works

Qwen sends each event to the hook as JSON on stdin and sets `QWEN_PROJECT_DIR`, which the hook uses as the project folder.

- `PreToolUse` runs for every tool. For `write_file`, `edit` and `notebook_edit` it runs the `pre-edit` phase. `write_file` carries `file_path` and the whole new `content`. `edit` carries `file_path`, `old_string`, `new_string` and `replace_all`, and the hook applies them to the file on disk. For every other tool it runs the `pre-tool` phase, and `run_shell_command` also marks the session as one that may have changed files.
- With pending violations, the hook prints `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "<pending list>"}}` and no decision. Qwen appends the text to the tool result after a blank line. When the edit makes `buckets.config.json` worse, the hook prints `permissionDecision: "deny"` with the reason in `permissionDecisionReason` instead.
- `Stop` and `SubagentStop` run the `stop` and `subagent-stop` phases, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "block", "reason": "<every violation in full>"}`. The next stop carries `stop_hook_active: true`, and the hook lets it through. Qwen also ends the turn by itself after 8 blocks, a cap that `stopHookBlockingCap` changes.
- `PostCompact` runs the `post-compact` phase after a successful compaction.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Qwen sets `QWEN_PROJECT_DIR`, but on Windows it can run hooks through `cmd.exe`, which does not read the variable the way bash does. If Qwen runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- `permissionDecision: "allow"` does not skip Qwen's approval prompt. The hook omits the decision anyway.
- Qwen cuts hook context to `tools.truncateToolOutputThreshold`.
- Every exit code other than 0 and 2 is a non-blocking error, so a missing `buckets` command lets the call through.
- On Windows, Qwen runs hooks through Git Bash when `MSYSTEM` or `TERM` points at it, else through `cmd.exe`.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Open Qwen Code in the project and trust the folder.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. The tool result should end with the pending list and `billing -> payments: private file`.
3. Let it end the turn without a fix. `Stop` should block once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send the `write_file` call that made it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"write_file","tool_input":{"file_path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent qwen pre-tool-use
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"Stop","stop_hook_active":false}' | buckets hook --agent qwen stop
```

The first command prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"buckets: 1 pending. ..."}}`. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

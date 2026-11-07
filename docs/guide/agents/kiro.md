---
title: Kiro
description: The hooks that buckets init writes in .kiro/hooks/ for Kiro CLI 3 and the Kiro IDE, and in .kiro/agents/ for Kiro CLI 2.x.
---

# Kiro

This page covers Kiro CLI 3 and Kiro IDE 1.x, which share one hook format, and Kiro CLI 2.x, which reads hooks from its agent configs.

| Phase | Support | How |
|---|---|---|
| Warning on edit | partial | `PreToolUse` prints the pending list on stdout. The IDE docs say it adds that text to the context, and the CLI ignores it |
| Pending list on other tools | partial | same |
| Interrupt on an invalid config | partial | `PreToolUse` exits with code 2 and the reason on stderr. Kiro does not block on Windows |
| Interrupt at the end | partial | `Stop` answers `decision: "block"` once in Kiro CLI 3. The IDE lists its stop event as unable to block, and Kiro CLI 2.x has no stop hook |
| Subagents | no | Kiro has no subagent event |
| Compaction | no | Kiro has no compaction event |

## Install

```sh
buckets init --agent kiro
```

It writes:

- `.kiro/hooks/slopbuckets.json`, read by Kiro CLI 3 and the Kiro IDE, with `"version": "v1"` and two hooks: `PreToolUse` with no matcher and a `timeout` of 60 seconds, and `Stop` with a `timeout` of 120 seconds. They run `buckets hook --agent kiro pre-tool-use` and `buckets hook --agent kiro stop`. If the file already exists, `init` keeps your hooks and adds only the missing ones.
- in every agent config in `.kiro/agents/*.json`, for Kiro CLI 2.x, a `hooks.preToolUse` entry that runs `buckets hook --agent kiro pre-tool-use` with `timeout_ms: 60000`. Kiro CLI 2.x cannot block a stop, so the agent configs get no stop hook.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

When `.kiro/agents/` holds no agent config, `init` tells you how to add the entry by hand to the agent you run with Kiro CLI 2.x, or to run `buckets init --agent kiro` again after you create it. It also reminds you that only Kiro CLI 3 lets the stop hook keep the agent working, and on Windows, that Kiro does not block a call when a hook exits with code 2.

Kiro reads every `.json` file in `.kiro/hooks/`, and Kiro CLI 3 also reads `~/.kiro/hooks/`. A hook that is in both a hook file and an agent config runs twice.

## How it works

Kiro sends each event as JSON on stdin with `hook_event_name`, `cwd`, `session_id`, `tool_name` and `tool_input`. The hook uses `cwd` as the project folder.

- `PreToolUse` runs for every tool. For `fs_write`, `fs_append`, `str_replace` and `delete_file`, and the Kiro CLI 2.x name `write`, it runs the `pre-edit` phase. `fs_write` with `command: "create"` carries `file_text`, and a replacement carries `old_str` and `new_str` (`oldStr` and `newStr` in the IDE), which the hook applies to the file on disk. These fields are not documented. The adapter reads the fields of the Amazon Q Developer CLI, Kiro's open source predecessor, which is inferred. For every other tool it runs the `pre-tool` phase, and `execute_bash`, `execute_pwsh` and the other shell tools also mark the session as one that may have changed files.
- With pending violations, the hook prints the pending list as plain text on stdout and exits 0. When the edit makes `buckets.config.json` worse, it exits with code 2 and the reason on stderr, which goes to the model.
- `Stop` runs the `stop` phase in Kiro CLI 3, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "block", "reason": "<every violation in full>"}` and exits 0, and Kiro starts another turn with the reason. The payload has no loop flag, so the hook keeps a mark per `session_id` in `.buckets/sessions/` of the project to block once.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Kiro sets no variable with the project folder. If Kiro runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- The CLI adds stdout to the context only for `SessionStart` and `UserPromptSubmit`, so in the CLI the pending list reaches the agent only at the end of a turn.
- In the CLI, a stop hook that exits 1 makes the agent continue. The hook exits 0 on any error of its own.
- On Windows, exit code 2 does not block (Kiro issue 8264, still open), so the config check does not hold there.
- Kiro IDE support for `Stop` and for stdout on tool hooks is unconfirmed: the IDE and CLI docs contradict each other.
- Whether workspace hooks fire inside a subagent is not documented.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Start Kiro CLI 3 in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts` and end the turn. The stop hook should send it back once with `buckets: 1 structure violation remains.`
3. On macOS or Linux, ask it to empty the `purpose` of a bucket in `buckets.config.json`. Kiro should refuse the edit with `buckets: edit not applied, buckets.config.json would be invalid.`

By hand, from the project folder, write a file with the violation, send the `fs_write` call that created it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"hook_event_name":"PreToolUse","cwd":"'"$PWD"'","session_id":"test","tool_name":"fs_write","tool_input":{"command":"create","path":"src/billing/refund.ts","file_text":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent kiro pre-tool-use
echo '{"hook_event_name":"Stop","cwd":"'"$PWD"'","session_id":"test"}' | buckets hook --agent kiro stop
```

The first command prints the pending list as text, starting with `buckets: 1 pending.`. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`, and the same stop sent again prints nothing. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

---
title: Devin
description: The hooks that buckets init writes in .devin/hooks.v1.json for Devin Local in Devin Desktop and the Devin CLI, which share one hook system.
---

# Devin

This page covers Devin Local in Devin Desktop and the Devin CLI. Devin Local runs the Devin CLI agent, so both read the same hook files. Cascade, the older agent in Devin Desktop, has its own page: [Windsurf](./windsurf).

| Phase | Support | How |
|---|---|---|
| Warning on edit | after the edit | `PostToolUse` returns the pending list in `additionalContext` |
| Pending list on other tools | after the tool | the same `PostToolUse` hook, with an empty matcher, returns the current pending list |
| Interrupt on an invalid config | yes | `PreToolUse` on the edit tools exits with code 2 and the reason on stderr |
| Interrupt at the end | yes | `Stop` answers `decision: "block"` once |
| Subagents | no | Devin has no subagent stop event |
| Compaction | yes | `PostCompact` clears the memory of what was shown |

## Install

```sh
buckets init --agent devin
```

It writes:

- `.devin/hooks.v1.json` with four hooks: `PreToolUse` with the matcher `^(write|edit|apply_patch|notebook_edit)$`, `PostToolUse` with the matcher `""`, which matches every tool, `Stop` and `PostCompact`. In this file the hooks object is the whole file, with no `hooks` wrapper key. Each hook runs `buckets hook --agent devin <event>`, with the events `pre-tool-use`, `post-tool-use`, `stop` and `post-compact`, and a timeout in seconds: 60 for the tool hooks, 600 for `Stop` and 30 for `PostCompact`. If the file already exists, `init` keeps your hooks and adds only the missing entries.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

slopbuckets 1.x wrote its entries under a `hooks` key in the same file. `init` does not recognize that key, so after an upgrade from 1.x, delete it from `.devin/hooks.v1.json` by hand.

Run `/hooks` in Devin to see the loaded hooks and the file each one comes from.

## How it works

Devin sends each event to the hook as JSON on stdin, with `tool_name` and `tool_input`, and sets `DEVIN_PROJECT_DIR`, which the hook uses as the project folder.

- `PreToolUse` with the matcher `^(write|edit|apply_patch|notebook_edit)$` sees the edit before it runs. The input fields of these tools are not documented, so the adapter reads the paths and text under every usual key, such as `file_path`, `content`, `old_string` and `new_string`, and patch text. When the edit makes `buckets.config.json` worse, the hook exits with code 2 and the reason on stderr, and prints nothing on stdout. Devin returns the reason to the agent, and the turn and the other tool calls continue. On any other call the hook prints nothing. This hook keeps no memory, so nothing counts as shown before `PostToolUse` shows it.
- `PostToolUse` runs for every tool and delivers the warning in `hookSpecificOutput.additionalContext`. For the edit tools, the hook reads the files as they are on disk now and checks them as an edit. For every other tool, it shows the current pending list, and `exec` also marks the session as one that may have changed files. Devin may also read `additionalContext` from `PreToolUse`, but its docs do not show it, so the adapter waits for a test in a live session.
- `Stop` runs the `stop` phase, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "block", "reason": "<every violation in full>"}`. The next stop carries `stop_hook_active: true`, and the hook lets it through.
- `PostCompact` runs the `post-compact` phase. Older builds name this event `PostCompaction`, which `init` does not install, so on those builds the memory of what was shown is never cleared.

## Limits

- After a project install, the hook command names the copy by the project folder that Devin sets, `node "$DEVIN_PROJECT_DIR/node_modules/slopbuckets/dist/index.js" hook ...`, so the hook finds it whatever folder the agent is in. The command needs a shell that expands `$DEVIN_PROJECT_DIR`, such as bash.
- `decision: "approve"` is documented as "allow the action" and probably skips the approval prompt, so the hook never prints a `decision` field on a tool event.
- Other exit codes, timeouts and bad output do not block, so a missing `buckets` command lets the call through.
- Whether hooks fire for tool calls inside a subagent is not documented.
- A hook can end the turn with `continue: false`. slopbuckets never prints it.
- Devin also reads `.claude/settings.json` while `read_config_from.claude` is on, the default. The Claude Code hook prints nothing when `DEVIN_PROJECT_DIR` is set, so the checks run once, through `.devin/hooks.v1.json`. Devin also runs Windsurf-format hooks from an undocumented file, so the [Windsurf](./windsurf) hook may fire there too.
- The shell that runs hooks on Windows is not documented.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Open the project in Devin Local, and check with `/hooks` that the slopbuckets hooks loaded from `.devin/hooks.v1.json`.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. After the edit, it should get the pending list with `billing -> payments: private file`.
3. Let it end the turn without a fix. `Stop` should block once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send the `PostToolUse` of the `write` that made it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"PostToolUse","tool_name":"write","tool_input":{"file_path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent devin post-tool-use
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"Stop","stop_hook_active":false}' | buckets hook --agent devin stop
```

The first command prints `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"buckets: 1 pending. ..."}}`. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

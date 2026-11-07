---
title: Gemini CLI
description: The hooks that buckets init writes in .gemini/settings.json for Gemini CLI, and why the warning arrives after the tool.
---

# Gemini CLI

| Phase | Support | How |
|---|---|---|
| Warning on edit | after the edit | `AfterTool` returns the pending list in `additionalContext` |
| Pending list on other tools | after the tool | the same `AfterTool` hook, with the matcher `.*`, returns the current pending list |
| Interrupt on an invalid config | yes | `BeforeTool` on `write_file` and `replace` answers `decision: "deny"` |
| Interrupt at the end | yes | `AfterAgent` answers `decision: "deny"` once |
| Subagents | no | Gemini has no subagent stop event |
| Compaction | no | Gemini has only `PreCompress`, which runs before the compression |

## Install

```sh
buckets init --agent gemini
```

It writes:

- the `hooks` key of `.gemini/settings.json` with three hooks: `BeforeTool` with the matcher `write_file|replace`, `AfterTool` with the matcher `.*`, and `AfterAgent` with no matcher. Each one runs `buckets hook --agent gemini <event>; exit 0`, with the events `before-tool`, `after-tool` and `after-agent`, a `name` that starts with `slopbuckets-`, and a timeout in milliseconds: 60,000 for the tool hooks and 600,000 for `AfterAgent`. If the file already exists, `init` keeps your settings and adds only the missing entries. It also replaces the 1.x entries.
- `context.fileName` in the same file, set to `["AGENTS.md", "GEMINI.md"]` when the key is missing, so Gemini reads the slopbuckets block. When the key is set and does not list `AGENTS.md`, `init` leaves it alone and tells you to add `AGENTS.md` to it.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Gemini ignores project settings in a folder you have not trusted, and it fingerprints project hooks: the first time it sees a new or changed hook, it asks before it runs it. `init` reminds you to trust the folder and the slopbuckets hooks when Gemini asks.

## How it works

Gemini sends each event to the hook as JSON on stdin, with `tool_name` and `tool_input` in snake_case. The hook uses `GEMINI_PROJECT_DIR` as the project folder when Gemini sets it.

- `BeforeTool` with the matcher `write_file|replace` sees the edit before it runs. `write_file` carries `file_path` and the whole new `content`. `replace` carries `file_path`, `old_string` and `new_string`. Gemini reads no context from `BeforeTool`, so the hook uses it only to refuse an edit that makes `buckets.config.json` worse, with `{"decision": "deny", "reason": "..."}` and exit code 0. On any other call it prints nothing. This hook keeps no memory, so nothing counts as shown before `AfterTool` shows it.
- `AfterTool` runs for every tool and delivers the warning. For `write_file` and `replace`, the hook reads the file as it is on disk now and checks it as an edit. For every other tool, it shows the current pending list, and `run_shell_command` also marks the session as one that may have changed files. With pending violations, the hook prints `{"hookSpecificOutput": {"hookEventName": "AfterTool", "additionalContext": "<pending list>"}}`, and Gemini appends it to the tool result inside `<hook_context>`. The hook never prints `decision` on `AfterTool`, because a deny there replaces the tool result.
- `AfterAgent` runs the `stop` phase, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "deny", "reason": "<every violation in full>"}`, and Gemini sends the reason back as a new prompt. The retry carries `stop_hook_active: true`, and the hook lets it through. Gemini has no cap of its own besides its limit of 100 turns.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Gemini sets `GEMINI_PROJECT_DIR`, but it runs hooks with PowerShell on Windows and with bash elsewhere, and no one way to write the variable works in both. If Gemini runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- `decision: "allow"` on `BeforeTool` does not skip Gemini's approval. The hook prints nothing on a call it does not refuse.
- When stdout is empty, Gemini reads stderr, and plain text with an exit code other than 0 or 1 becomes a deny. On bash, a missing `buckets` command exits 127 and would deny every matched call and make `AfterAgent` retry. Every installed command ends with `; exit 0`, which works in bash and in PowerShell, so the hook exits 0 when `buckets` is missing.
- Tool hooks fire inside subagents, but `AfterAgent` fires only for the main loop, so a subagent's end is not checked. This is read from the source, not tested.
- On Windows, Gemini runs hook commands with PowerShell, and on other systems with `bash -c`.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Open Gemini CLI in the project, trust the folder and accept the hooks when it asks.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. The tool result should end with the pending list and `billing -> payments: private file`.
3. Let it end the turn without a fix. `AfterAgent` should send it back once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send the `AfterTool` of the `write_file` that made it, then the `AfterAgent` of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"AfterTool","tool_name":"write_file","tool_input":{"file_path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent gemini after-tool
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"AfterAgent","stop_hook_active":false}' | buckets hook --agent gemini after-agent
```

The first command prints `{"hookSpecificOutput":{"hookEventName":"AfterTool","additionalContext":"buckets: 1 pending. ..."}}`. The second prints `{"decision":"deny","reason":"buckets: 1 structure violation remains. ..."}`. An `AfterAgent` without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

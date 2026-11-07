---
title: Crush
description: The PreToolUse hook that buckets init writes for Crush, the only hook event Crush has.
---

# Crush

| Phase | Support | How |
|---|---|---|
| Warning on edit | yes | `PreToolUse` simulates the edit and returns the pending list in `context` |
| Pending list on other tools | yes | the same `PreToolUse` hook, which has no matcher, returns the current pending list |
| Interrupt on an invalid config | yes | `PreToolUse` answers `decision: "deny"` |
| Interrupt at the end | no | Crush has no stop event |
| Subagents | no | hooks do not run inside Crush sub-agents |
| Compaction | no | Crush has no compaction event |

## Install

```sh
buckets init --agent crush
```

It writes:

- one `PreToolUse` hook named `slopbuckets` with no matcher and a timeout of 60 seconds, which runs `buckets hook --agent crush pre-tool-use`. It goes in one file: the project's `.crushrc` or `crushrc` when one exists, as the line `hook add PreToolUse --name slopbuckets --command 'buckets hook --agent crush pre-tool-use' --timeout 60  # slopbuckets`, else an existing `.crush.json` or `crush.json`, else a new `.crush.json`. A crushrc wins over the JSON config, which is why `init` prefers it. An entry that an earlier `init` wrote in a JSON config stays there when you add a crushrc later, so delete it by hand.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

`init` also reminds you that Crush has no stop hook, and suggests `buckets init --git-hook`.

## How it works

Crush sends `PreToolUse` the JSON `{ event, session_id, cwd, tool_name, tool_input }` on stdin for every tool of the top-level agent, and sets `CRUSH_PROJECT_DIR`, which the hook uses as the project folder.

- For `write`, `edit` and `multiedit` the hook runs the `pre-edit` phase. It computes the new file from `tool_input`: `content` for `write`, or the file on disk with `old_string` and `new_string` applied, every occurrence with `replace_all`. An empty `old_string` on a missing or empty file creates it with `new_string`, as Crush's edit does. For `download` and `lsp_replace_symbol`, the new text is not in the input, so the hook shows the current pending list and marks the session as one that changed files.
- For every other tool it runs the `pre-tool` phase, and `bash` calls also mark the session. `lsp_rename` can change many files, and their paths are not known before it runs, so the hook cannot simulate it.
- With pending violations, the hook prints `{"context": "<pending list>"}` with no `decision`. Crush appends the text to the tool result. When the edit makes `buckets.config.json` worse, it prints `{"decision": "deny", "reason": "..."}`, which refuses that call alone. With nothing to say, it exits 0 with empty stdout.

## Limits

- After a project install, the hook command names the copy by the project folder that Crush sets, `node "$CRUSH_PROJECT_DIR/node_modules/slopbuckets/dist/index.js" hook ...`, so the hook finds it whatever folder the agent is in. Crush runs hooks in its embedded POSIX shell, which expands the variable.
- `decision: "allow"` pre-approves the call and skips the permission prompt, so the hook never prints it.
- Crush drops the `context` when the tool returns an error.
- Crush has no stop event, so nothing runs `buckets check` before the agent stops. The `AGENTS.md` block tells the agent to run it.
- Exit codes other than 0, 2 and 49 are non-blocking errors, so a missing `buckets` command lets the call through.
- Crush runs hooks in its embedded POSIX shell on every system. Whether that shell finds `buckets.cmd` on Windows is not documented.
- When `.crush.json` and a crushrc in the same folder both set `hooks`, the crushrc wins, and how the two merge is not documented.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Start Crush in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. The tool result should end with the pending list and `billing -> payments: private file`.

By hand, from the project folder, send the `write` call that creates a file with the violation:

```sh
echo '{"event":"PreToolUse","session_id":"test","cwd":"'"$PWD"'","tool_name":"write","tool_input":{"file_path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent crush pre-tool-use
```

It prints `{"context":"buckets: 1 pending. ..."}` and writes nothing to `src/billing/refund.ts`. Crush has no stop event, so there is no stop to try. Delete `.buckets/sessions/test.json` afterwards.

---
title: Goose
description: The plugin hooks that buckets init writes in .agents/plugins/ for Goose, which can refuse an edit and block the end of a turn.
---

# Goose

| Phase | Support | How |
|---|---|---|
| Warning on edit | no | Goose reads no context from any hook |
| Pending list on other tools | no | same |
| Interrupt on an invalid config | yes | `PreToolUse` answers `decision: "block"` |
| Interrupt at the end | yes | `Stop` answers `decision: "block"` once |
| Subagents | unverified | the `Stop` hook probably runs at the end of a subagent too, with the subagent's own session id |
| Compaction | no | Goose has no compaction event |

## Install

```sh
buckets init --agent goose
```

It writes:

- a project plugin in `.agents/plugins/slopbuckets/`, with a `plugin.json` manifest and `hooks/hooks.json`. The hooks file has `PreToolUse` with the matcher `(?:^|__)(?:shell|write|edit|text_editor)$` and a timeout of 60 seconds, and `Stop` with a timeout of 600 seconds. They run `buckets hook --agent goose pre-tool-use` and `buckets hook --agent goose stop`. Running `init` again replaces the 1.x entries, which set `on_failure`.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

When it writes the hooks, `init` reminds you that Goose runs hooks with `sh`, so Windows needs `sh` on the PATH, and that Goose shows hook text to no one, so the agent sees the structure problems only when the stop hook blocks.

Goose reads project plugins from the folder where the agent starts. A plugin listed in `disabledPlugins` in the Goose settings is skipped.

## How it works

Goose sends each event as JSON on stdin with `session_id`, `tool_name`, `tool_input` and `working_dir`. The hook uses `working_dir` as the project folder.

- `PreToolUse` with the matcher `(?:^|__)(?:shell|write|edit|text_editor)$` sees the call before it runs. The matcher accepts both the bare names and an extension prefix such as `developer__`, and the hook reads the tool kind from the part after the last `__`. `write` carries `path` and the whole new `content`, `edit` carries `path`, `before` and `after`, and `text_editor` is the tool of the older developer extension. When the edit makes `buckets.config.json` worse, the hook prints `{"decision": "block", "reason": "..."}` and exits 0. Otherwise it exits 0 with empty stdout, the allow that Goose expects. Goose reads no context, so the hook prints no pending list, but it still records the edit and marks the session as one that changed files. `shell` calls mark the session too.
- `Stop` runs the `stop` phase, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "block", "reason": "<every violation in full>"}`, and Goose adds the reason as a hidden user message and continues. The payload has no loop flag, so the hook keeps a mark per `session_id` in `.buckets/sessions/` of the project to block once. Goose also ends the turn by itself after 8 blocks, a cap that `GOOSE_STOP_HOOK_BLOCK_CAP` changes.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Goose sets no variable with the project folder. If Goose runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- No output of any Goose hook reaches the model except a block reason, so the pending list arrives only at the end of a turn.
- In approve mode, Goose asks the user before the hook runs, so no hook answer can skip the prompt.
- Stray text on stdout turns an allow into a hook failure, which still allows but logs a warning. The hook writes its logs to stderr.
- A hook that fails, such as on a machine without the CLI, allows the call under Goose's default `on_failure: "allow"`, and a failing stop hook always lets the turn end.
- Goose runs every hook command with `sh -c`, also on Windows, so Windows needs `sh` on the PATH, for example from Git for Windows.
- Hooks inside subagents are read from the Goose source, not tested in a live session.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Start Goose in the project folder.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts` and end the turn. The stop hook should send it back once with `buckets: 1 structure violation remains.`
3. Ask it to empty the `purpose` of a bucket in `buckets.config.json`. Goose should refuse the edit with `buckets: edit not applied, buckets.config.json would be invalid.`

By hand, from the project folder, write a file with the violation, send the `write` call that created it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"event":"PreToolUse","session_id":"test","working_dir":"'"$PWD"'","tool_name":"write","tool_input":{"path":"src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent goose pre-tool-use
echo '{"event":"Stop","session_id":"test","working_dir":"'"$PWD"'"}' | buckets hook --agent goose stop
```

The first command prints nothing. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`, and the same stop sent again prints nothing. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

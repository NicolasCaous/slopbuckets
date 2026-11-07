---
title: OpenCode
description: The plugin that buckets init writes in .opencode/plugins/ for OpenCode 1 and OpenCode 2, and the re-prompt that stands in for a stop hook.
---

# OpenCode

This page covers both OpenCode lines. OpenCode 1 is the npm package `opencode-ai` with the plugin API `@opencode-ai/plugin`. OpenCode 2 is the npm package `@opencode/cli` with the plugin API `@opencode/plugin`. One plugin file serves both.

| Phase | Support | How |
|---|---|---|
| Warning on edit | after the edit | the before hook computes the pending list and the after hook appends it to the output of the edit tool |
| Pending list on other tools | after the tool | the same, for every other tool |
| Interrupt on an invalid config | yes | the before hook throws, which fails that call alone |
| Interrupt at the end | partial | OpenCode has no stop hook. The plugin sends the report as a new message when the session goes idle, once per user turn |
| Subagents | yes | after a `task` or `subagent` call, the plugin checks the child session and appends the report to the call's output |
| Compaction | yes | the plugin listens for the compaction event and clears the memory of what was shown |

## Install

```sh
buckets init --agent opencode
```

It writes:

- `.opencode/plugins/slopbuckets.ts`, the plugin. If you already have a file with that name, `init` leaves it alone and writes `.opencode/plugins/slopbuckets-hooks.ts` instead. Running `init` again rewrites the plugin in place, a 1.x plugin included, under whichever of the two names it has. The plugin carries the line `slopbuckets:managed-plugin`, which is how `init` tells it from your own file.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which OpenCode reads

OpenCode loads every file in `.opencode/plugins/` when it starts, so there is no config to edit. Restart OpenCode after `init`.

The plugin default-exports an object with `server()` for OpenCode 1 and `setup()` for OpenCode 2. The V2 docs say OpenCode 1 reads this combined export from 1.18.29.

## How it works

The plugin holds no rules. For each event it starts `buckets hook --agent opencode <event>` with a JSON object on stdin, such as `{"cwd", "sessionId", "tool", "args"}`, and reads one JSON line back: `{"kind": "silent"}`, `{"kind": "context", "text": "..."}`, `{"kind": "deny", "text": "..."}` or `{"kind": "block", "text": "..."}`. It looks for the CLI in `SLOPBUCKETS_BIN`, then in `node_modules/slopbuckets` of the project or a folder above it, then as `buckets` on the PATH, and runs a JavaScript entry with the `node` on the PATH. A call that takes longer than 10 seconds for a tool or 60 seconds for a stop counts as a failure: the tool runs, and the plugin warns once per session on stderr, and in OpenCode 1 also in the app log and a toast. A missing CLI gets the same kind of warning once, with how to install it.

- OpenCode 1 calls `tool.execute.before` and OpenCode 2 calls `execute.before` before each tool. The plugin sends every call as the `pre-tool` event, and the CLI runs the `pre-edit` phase when the call edits files it can name: `edit` and `write`, with the path in `filePath` (OpenCode 1) or `path` (OpenCode 2), and `apply_patch` (`patch` in OpenCode 2) with its patch text. `edit` carries `oldString` and `newString`, and an empty `oldString` writes `newString` as the whole file. `bash` and `shell` calls mark the session as one that may have changed files. Every other tool gets the `pre-tool` phase.
- Neither line has a field that adds context before the tool runs, so the plugin keeps the text by call id: `callID` in OpenCode 1, `id` in OpenCode 2. After the tool, `tool.execute.after` (OpenCode 1) appends the kept text to `output.output`, and `execute.after` (OpenCode 2) appends it to `result.content` when `status` is `completed`. When the edit makes `buckets.config.json` worse, the before hook throws instead, and the model sees the error for that call.
- After a `task` (OpenCode 1) or `subagent` (OpenCode 2) call, the plugin runs the `subagent-stop` event for the child session named in the call's metadata. When the child changed files and left violations, the report goes at the end of the call's output, so the parent reads it.
- When the session goes idle, the plugin runs the `stop` event. It checks only when the session changed files or still has pending violations. With violations, it sends the report with `session.prompt`, starting with `[slopbuckets] `, once per user turn. It skips child sessions, which have a `parentID`, and the first idle after a session error.
- On `session.compacted` (OpenCode 1) or `session.compaction.ended` (OpenCode 2), the plugin runs the `post-compact` event.

OpenCode 1 offers `apply_patch` instead of `edit` and `write` for models whose id contains `gpt-`. OpenCode 2 also runs the before hook for tools nested in its codemode tool.

## Limits

- The before hooks never touch permissions, so returning without a throw never approves a call. The plugin registers no permission hook.
- In OpenCode 1, a tool that fails skips `tool.execute.after`, and the warning for that call is lost.
- The idle re-prompt starts a new turn after the old one ended, and it never runs in `opencode run`, which exits on idle.
- The plugin runs inside OpenCode on Bun and starts the CLI with `node`, which handles the `buckets.cmd` shim on Windows.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Restart OpenCode in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. The edit output should end with the pending list and `billing -> payments: private file`.
3. Let it end the turn without a fix. When the session goes idle, OpenCode should get a new message with `buckets: 1 structure violation remains.`

By hand, from the project folder, send what the plugin sends: write a file with the violation, send the `write` call that made it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"cwd":"'"$PWD"'","sessionId":"test","tool":"write","args":{"filePath":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent opencode pre-tool
echo '{"cwd":"'"$PWD"'","sessionId":"test"}' | buckets hook --agent opencode stop
```

The first command prints `{"kind":"context","text":"buckets: 1 pending. ..."}`. The second prints `{"kind":"block","text":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints `{"kind":"silent"}`. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

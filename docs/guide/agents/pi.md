---
title: Pi
description: The extension that buckets init writes in .pi/extensions/ for the Pi coding agent, and the project trust it needs.
---

# Pi

This page covers the Pi coding agent, the npm package `@earendil-works/pi-coding-agent`. Pi has no shell hooks. It loads TypeScript extensions, and slopbuckets installs one. The check at the end of a turn needs Pi 0.87.0 or newer.

| Phase | Support | How |
|---|---|---|
| Warning on edit | yes | the `tool_call` handler sends the pending list as a steering message, which the model reads after the tool batch |
| Pending list on other tools | yes | the same, for every other tool |
| Interrupt on an invalid config | yes | the `tool_call` handler returns `{ block: true, reason }` |
| Interrupt at the end | yes | the `agent_before_settle` handler adds the report and asks for one more model request, once per user turn |
| Subagents | no | Pi has no built-in subagents |
| Compaction | yes | the `session_compact` handler clears the memory of what was shown |

## Install

```sh
buckets init --agent pi
```

It writes:

- `.pi/extensions/slopbuckets.ts`, the extension. If you already have a file with that name, `init` leaves it alone and writes `.pi/extensions/slopbuckets-hooks.ts` instead. Running `init` again rewrites the extension in place, a 1.x one included, under whichever of the two names it has. The extension carries the line `slopbuckets:managed-plugin`, which is how `init` tells it from your own file.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Pi reads

`init` reminds you that Pi loads extensions from `.pi/extensions/` only in a trusted project:

1. Start Pi in the project folder. Because `.pi/extensions` exists, Pi asks whether to trust the project. Answer yes, or run `/trust` to save the decision.
2. Print, JSON and RPC modes cannot ask. Pass `--approve` for one run, save the decision with `/trust` first, or set `defaultProjectTrust` to `"always"` in `~/.pi/agent/settings.json`.

## How it works

The extension holds no rules. For each event it starts `buckets hook --agent pi <event>` with a JSON object on stdin, such as `{"cwd", "sessionId", "tool", "args"}`, and reads one JSON line back: `{"kind": "silent"}`, `{"kind": "context", "text": "..."}`, `{"kind": "deny", "text": "..."}` or `{"kind": "block", "text": "..."}`. It looks for the CLI in `SLOPBUCKETS_BIN`, then in `node_modules/slopbuckets` of the project or a folder above it, then as `buckets` on the PATH. A call that takes longer than 10 seconds for a tool or 60 seconds for a stop counts as a failure: the tool runs, and the extension warns once per session on stderr and with `ctx.ui.notify` when Pi has a UI. A missing CLI gets the same kind of warning once, with how to install it.

- `tool_call` fires before each tool. The extension sends every call as the `pre-tool` event, and the CLI runs the `pre-edit` phase for `edit` and `write`. `edit` carries `path` and `edits: [{ oldText, newText }]`, which the CLI applies to the file on disk, and `write` carries `path` and `content`. An edit with an empty `oldText` has unknown content: the CLI shows the current pending list and marks the session as one that changed files. `bash` and `powershell` calls also mark the session. Every other tool gets the `pre-tool` phase.
- With pending violations, the extension calls `pi.sendMessage({ customType: "slopbuckets", content, display: false }, { deliverAs: "steer" })`. When that call throws, it keeps the text by `toolCallId` and appends it to the tool result in `tool_result` instead, passing `structuredContent` through. When the edit makes `buckets.config.json` worse, `tool_call` returns `{ block: true, reason }`.
- `agent_before_settle` runs the `stop` event when `outcome` is `completed` or missing. The CLI checks only when the session changed files or still has pending violations. With violations, the handler returns a `custom_message` entry with the report and `continue: true`. Pi has no flag for a continuation in progress, so the extension keeps its own per-session flag, which resets only when a run starts with `messageType: "user"`. On a Pi without `agent_before_settle`, the extension warns once that the end-of-turn check is off.
- `session_compact` runs the `post-compact` event.

## Limits

- Pi has no approval prompt for built-in tools, so no return value approves anything.
- A `tool_call` handler that throws blocks the tool. The extension catches every error and lets the call run.
- Pi documents no cap on continuations, so the once-per-turn flag is the only loop guard.
- Using the steering message from inside `tool_call` is inferred from the docs, not tested in a live session.
- The `subagent` example extension starts a separate `pi` process, which loads the project extensions in a trusted project. Its own stop handler would then check the subagent, which is inferred.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Start Pi in the project and trust it.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. After the tool batch, it should get the pending list with `billing -> payments: private file`.
3. Let it end the turn without a fix. Pi should make one more request with `buckets: 1 structure violation remains.`

By hand, from the project folder, send what the extension sends: write a file with the violation, send the `write` call that made it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"cwd":"'"$PWD"'","sessionId":"test","tool":"write","args":{"path":"src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent pi pre-tool
echo '{"cwd":"'"$PWD"'","sessionId":"test"}' | buckets hook --agent pi stop
```

The first command prints `{"kind":"context","text":"buckets: 1 pending. ..."}`. The second prints `{"kind":"block","text":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints `{"kind":"silent"}`. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

---
title: Amp
description: The plugin that buckets init writes in .amp/plugins/ for Amp, built on Amp's plugin API, and the allow it has to return.
---

# Amp

This page covers Amp from ampcode.com. Amp has no shell hooks. It loads TypeScript plugins, and slopbuckets installs one.

| Phase | Support | How |
|---|---|---|
| Warning on edit | after the edit | the `tool.call` handler computes the pending list and the `tool.result` handler appends it to the tool output |
| Pending list on other tools | after the tool | the same, for every other tool |
| Interrupt on an invalid config | yes | the `tool.call` handler returns `reject-and-continue` with the reason |
| Interrupt at the end | yes | the `agent.end` handler continues the agent once with the report |
| Subagents | unverified | the same handler on a thread with a parent checks the subagent, but no doc says that a subagent fires `agent.end` |
| Compaction | no | Amp has no compaction event |

## Install

```sh
buckets init --agent amp
```

It writes:

- `.amp/plugins/slopbuckets.ts`, the plugin. If you already have a file with that name, `init` leaves it alone and writes `.amp/plugins/slopbuckets-hooks.ts` instead. Running `init` again rewrites the plugin in place, a 1.x one included, under whichever of the two names it has. The plugin carries the line `slopbuckets:managed-plugin`, which is how `init` tells it from your own file.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Amp reads

Amp loads the plugins in `.amp/plugins/` with Bun, following its plugin activation settings, in interactive sessions and in `amp --execute` runs. After `init`, restart Amp or run `plugins: reload`. `amp plugins list` shows the plugin.

## How it works

The plugin holds no rules. For each event it starts `buckets hook --agent amp <event>` with a JSON object on stdin, such as `{"cwd", "sessionId", "tool", "args", "paths"}`, and reads one JSON line back: `{"kind": "silent"}`, `{"kind": "context", "text": "..."}`, `{"kind": "deny", "text": "..."}` or `{"kind": "block", "text": "..."}`. It looks for the CLI in `SLOPBUCKETS_BIN`, then in `node_modules/slopbuckets` of the project or a folder above it, then as `buckets` on the PATH, and runs a JavaScript entry with the `node` on the PATH. A call that takes longer than 10 seconds for a tool or 60 seconds for a stop counts as a failure: the tool runs, and the plugin warns once per session on stderr and with `ctx.ui.notify`. A missing CLI gets the same kind of warning once, with how to install it. The thread id is the session id.

- `tool.call` fires before each tool, and Amp has no matcher. Amp does not document its tool names or input fields, so the plugin asks Amp's helpers: `amp.helpers.shellCommandFromToolCall` for the command of a shell call, which marks the session as one that may have changed files, and `amp.helpers.filesModifiedByToolCall` for the files any other call modifies. The plugin sends every call as the `pre-tool` event, and the CLI runs the `pre-edit` phase when the call modifies files. For one file, it takes the new text from the raw input when it holds `content`, or an old and new string pair such as `old_str` and `new_str`, applied to the file on disk. An empty old string, or several files, leave the content unknown, and the CLI shows the current pending list instead. Patch text in the input is applied file by file.
- Amp's result type has no context field, so the plugin keeps the text by `toolUseID`. `tool.result` with `status: "done"` appends the kept text to the output before Amp sends it to the model. When the edit makes `buckets.config.json` worse, `tool.call` returns `{ action: "reject-and-continue", message }` with the reason. Every other call returns `{ action: "allow" }`.
- `agent.end` with `status: "done"` runs the `stop` event, or `subagent-stop` when `ctx.thread.parentThreadID()` names a parent. The CLI checks only when the thread changed files or still has pending violations. With violations, the plugin returns `{ action: "continue", userMessage, maxContinuations: 1 }`, with the report after `[slopbuckets] `. Amp has no flag for a continuation, so the plugin keeps its own per-thread flag, which resets when a user message starts the agent and stays set for its own message.

A steering message with `ctx.thread.appendUserMessage(..., { steer: true })` may deliver the warning earlier, as a visible user message. The plugin does not use it until a test shows the timing.

## Limits

- `tool.call` must return a result, and its result type has no neutral value: the choices are `allow`, `reject-and-continue`, `modify`, `synthesize` and `error`. So the plugin returns `allow` for every call it does not deny. Amp does not ask for approval before tools by default, so this skips no prompt there. If you use a permission plugin, such as one that rejects some shell commands or shows a confirm dialog, check that it still works with slopbuckets installed: Amp does not document how the answers of several plugins combine, so the `allow` of slopbuckets might override its reject.
- Amp ignores `continue` after 5 plugin continuations in a row. The plugin asks for 1.
- Reading the new content from the raw input relies on tool input fields that Amp does not document, and no test in a live session has checked them.
- Subagent threads probably fire `agent.end` too. No doc states it for the built-in subagent.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Restart Amp in the project and check that `amp plugins list` shows the plugin.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. The tool output should end with the pending list and `billing -> payments: private file`.
3. Let it end the turn without a fix. Amp should continue once with `buckets: 1 structure violation remains.`

By hand, from the project folder, send what the plugin sends: write a file with the violation, send the call that created it with the path Amp's helper names, then the stop of the same thread:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"cwd":"'"$PWD"'","sessionId":"test","tool":"create_file","args":{"path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"},"paths":["'"$PWD"'/src/billing/refund.ts"]}' | buckets hook --agent amp pre-tool
echo '{"cwd":"'"$PWD"'","sessionId":"test"}' | buckets hook --agent amp stop
```

The first command prints `{"kind":"context","text":"buckets: 1 pending. ..."}`. The second prints `{"kind":"block","text":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints `{"kind":"silent"}`. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

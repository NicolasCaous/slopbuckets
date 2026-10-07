---
title: Amp
description: The plugin that buckets init writes in .amp/plugins/ for Amp, built on Amp's plugin API.
---

# Amp

This page covers Amp from ampcode.com. Amp has no shell hooks and no approval prompts. It loads TypeScript plugins, and a plugin is the only place that can refuse a tool call, so slopbuckets installs one.

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | The `tool.call` handler returns `reject-and-continue` with the reason, and the agent continues without the tool |
| Feedback after edits | yes | The `tool.result` handler appends the `buckets check --file` report to the tool output |
| Block the end of a turn | yes | The `agent.end` handler continues the agent once with the report, with `maxContinuations: 1` |

## Install

```sh
buckets init --agent amp
```

It writes:

- `.amp/plugins/slopbuckets.ts`, the plugin. If you already have a file with that name, `init` leaves it alone and writes `.amp/plugins/slopbuckets-hooks.ts` instead.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Amp reads.

Amp loads every `.ts` file in `.amp/plugins/` with Bun when it runs in the project folder, without a prompt. After `init`, restart Amp or run `plugins: reload` from the command palette (`Ctrl+O`). `amp plugins list` shows the plugin and the events it handles.

The plugin starts the `buckets` command for each guarded tool call, so the machine needs it:

- a project install, `npm i -D slopbuckets`, which the plugin finds in `node_modules` of the project or a folder above it
- or a global install, `npm i -g slopbuckets`
- or the environment variable `SLOPBUCKETS_BIN` set to the path of the `buckets` command or of its `dist/index.js`

The plugin starts the CLI with the `node` on `PATH`. On Windows, a global npm install puts a `buckets.cmd` shim on `PATH`. The plugin runs the real `index.js` next to the shim with `node`, and goes through `cmd.exe` only when it cannot find it.

## How it works

The plugin holds no rules and does not depend on Amp's tool names. For each tool call it asks Amp's helpers what the call does: `amp.helpers.filesModifiedByToolCall` lists the files it writes, and `amp.helpers.shellCommandFromToolCall` returns the shell command and its folder. A call that does neither, such as a read, runs without a call to the CLI. For the others, the plugin runs `buckets hook --agent amp <event>`, writes one JSON object on stdin with the files or the command and the thread id, and reads one JSON line back.

Before the tool runs, `tool.call` asks for `pre-tool-use`. When the answer is `{"decision": "deny", "reason": "..."}`, the handler returns `{ action: "reject-and-continue", message }`. Amp does not run the tool, shows the reason, and the model picks another way. That covers a write to any `buckets.lock.json` or `buckets.config.json`, a shell command that names one, and `buckets refresh` with anything but exactly `--web`. `buckets refresh --web > refresh.log 2>&1 &` passes.

After a tool that modified files finishes with status `done`, `tool.result` asks for `post-tool-use`. When a file has problems, the handler returns the output with the report added: after a text output, as one more text part of a list, or as a `slopbuckets` field of an object output.

When the agent finishes a turn with status `done`, `agent.end` asks for `stop`, which runs the full `buckets check`. When the check fails, the handler returns `{ action: "continue", userMessage, maxContinuations: 1 }`. Amp sends the report as the next user message, which starts with `[slopbuckets]`, and the agent answers it. The plugin also keeps a flag per thread: after one continuation, it lets the turn end, and only a message from you, not one that starts with `[slopbuckets]`, clears the flag.

## Limits

- Amp's plugin API is young, and Amp marks parts of it as experimental. A change in the events, the helpers or the result shapes can break the plugin until slopbuckets updates it.
- The guard is as good as Amp's helpers. A tool whose file writes `filesModifiedByToolCall` does not report, such as a tool from another plugin or an MCP server, is not checked.
- The end-of-turn check runs only for a turn that ends with status `done`, not after an error or a cancel. There is no separate check when a subagent ends; the check at the end of the main turn covers its work.
- The plugin fails open, like every slopbuckets integration. When the `buckets` command is missing, fails or prints something that is not JSON, the plugin allows the call, adds no feedback and does not continue the agent. It warns once per thread on stderr and with `ctx.ui.notify`.
- Each call has a timeout: 10 seconds before a tool, 30 seconds after an edit and 60 seconds for the end-of-turn check. A call that times out counts as a failure and the tool runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start Amp in the project folder and check that `amp plugins list` shows `slopbuckets`.
2. Ask it to "write `{}` to buckets.lock.json". The edit should be rejected with the reason from slopbuckets, which names the lock and `buckets refresh --web`.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. The output of the edit should carry the `buckets check --file` report.
4. In a project whose check fails, for example before the first `buckets refresh`, ask a short question. After the answer, one `[slopbuckets]` message with the report should follow, and no second one.

You can also run a hook by hand from the project folder:

```sh
echo '{"paths":["buckets.lock.json"]}' | buckets hook --agent amp pre-tool-use
```

It prints `{"decision":"deny","reason":"..."}`.

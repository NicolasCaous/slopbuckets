---
title: Pi
description: The extension that buckets init writes in .pi/extensions/ for the Pi coding agent, and the project trust it needs.
---

# Pi

This page covers the Pi coding agent, the npm package `@earendil-works/pi-coding-agent`. Pi has no shell hooks. It loads TypeScript extensions, and slopbuckets installs one.

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | The `tool_call` handler returns `{ block: true, reason }`, and Pi skips the tool |
| Feedback after edits | yes | The `tool_result` handler appends the `buckets check --file` report to the result of `edit` and `write` |
| Block the end of a turn | yes | The `agent_before_settle` handler adds the report and asks Pi for one more model request, once per user turn. It needs Pi 0.87.0 or newer |

## Install

```sh
buckets init --agent pi
```

It writes:

- `.pi/extensions/slopbuckets.ts`, the extension. If you already have a file with that name, `init` leaves it alone and writes `.pi/extensions/slopbuckets-hooks.ts` instead.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Pi reads.

Pi loads extensions from `.pi/extensions/` only in a trusted project:

1. Start Pi in the project folder. Because `.pi/extensions` exists, Pi asks whether to trust the project. Answer yes, or run `/trust` to save the decision for later runs. The decision lives in `~/.pi/agent/trust.json`.
2. Print, JSON and RPC modes cannot ask. Pass `--approve` for one run, save the decision with `/trust` first, or set `defaultProjectTrust` to `"always"` in `~/.pi/agent/settings.json`. Without one of these, Pi skips the extension in those modes.
3. After you change the extension file, run `/reload` or restart Pi.

The extension starts the `buckets` command for each guarded tool call, so the machine needs it:

- a project install, `npm i -D slopbuckets`, which the extension finds in `node_modules` of the project or a folder above it
- or a global install, `npm i -g slopbuckets`
- or the environment variable `SLOPBUCKETS_BIN` set to the path of the `buckets` command or of its `dist/index.js`

On Windows, a global npm install puts a `buckets.cmd` shim on `PATH`, which Node cannot start without a shell. The extension runs the real `index.js` next to the shim with `node` instead, and goes through `cmd.exe` only when it cannot find it.

## How it works

The extension holds no rules. For each guarded tool call it runs `buckets hook --agent pi <event>`, writes one JSON object on stdin with the tool name, its arguments, Pi's working folder and the session id, and reads one JSON line back. The CLI reads `command` from `bash` and `powershell`, and `path` from `edit` and `write`. Pi has no patch tool. Other tools, such as `read`, run without a call to the CLI.

Before a guarded tool runs, `tool_call` asks for `pre-tool-use`. When the answer is `{"decision": "deny", "reason": "..."}`, the handler returns `{ block: true, reason }`. Pi does not run the tool and hands the reason to the model. That covers a write to any `buckets.lock.json` or `buckets.config.json`, a shell command that names one, and `buckets refresh` with anything but exactly `--web`. `buckets refresh --web > refresh.log 2>&1 &` passes.

After `edit` or `write` succeeds, `tool_result` asks for `post-tool-use`. When the file has problems, the handler returns the tool's content with the report added as one more text part, so the model reads it with the result.

When the agent is about to settle, `agent_before_settle` asks for `stop`, which runs the full `buckets check`. When the check fails, the handler appends a `custom_message` entry with the report, shown in the transcript, and returns `continue: true`, so Pi makes one more model request with the report in context. A flag per session keeps this to once per user turn, and `before_agent_start`, which runs when you send a prompt, clears it. A turn that ended with an abort or an error gets no check.

## Limits

- `agent_before_settle` exists since Pi 0.87.0. An older Pi never calls it, so it gets the lock guard and the feedback after edits, but no end-of-turn check.
- Pi skips project extensions until you trust the project, and in print, JSON and RPC modes when nothing decided trust. Then nothing is guarded. Trust is per folder on each machine, so every person who clones the project decides it once.
- Pi has no subagents, so there is no separate check when one ends.
- Pi runs the `tool_call` handlers of a codemode script's nested calls too, so those calls are guarded. A tool from another extension or an MCP server that writes files is not checked.
- The extension fails open, like every slopbuckets integration. When the `buckets` command is missing, fails or prints something that is not JSON, the extension allows the call, adds no feedback and does not continue the agent. It warns once per session on stderr and, when Pi has a UI, as a notification. A handler error in `tool_call` would block the tool in Pi, so the extension catches every error there and allows.
- Each call has a timeout: 10 seconds before a tool, 30 seconds after an edit and 60 seconds for the end-of-turn check. A call that times out counts as a failure and the tool runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start Pi in the project folder and trust the project.
2. Ask it to "write `{}` to buckets.lock.json". The write should be blocked with the reason from slopbuckets, which names the lock and `buckets refresh --web`.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. The result of the edit should end with the `buckets check --file` report.
4. In a project whose check fails, for example before the first `buckets refresh`, ask a short question. Before Pi settles, a slopbuckets message with the report should appear once and the agent should answer it.

You can also run a hook by hand from the project folder:

```sh
echo '{"tool":"write","args":{"path":"buckets.lock.json"}}' | buckets hook --agent pi pre-tool-use
```

It prints `{"decision":"deny","reason":"..."}`.

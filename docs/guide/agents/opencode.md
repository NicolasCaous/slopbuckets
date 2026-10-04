---
title: OpenCode
description: The plugin that buckets init writes in .opencode/plugins/ for OpenCode 1 and OpenCode 2, and the re-prompt that stands in for a stop hook.
---

# OpenCode

This page covers both OpenCode lines. OpenCode 1 is the npm package `opencode-ai` with the plugin API `@opencode-ai/plugin`. OpenCode 2 is the npm package `@opencode/cli` with the plugin API `@opencode/plugin`. The two lines load plugins differently and name their tools differently, and one plugin file serves both.

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | The plugin throws before the tool runs, which refuses the call even when every permission is set to allow |
| Feedback after edits | yes | The plugin appends the `buckets check --file` report to the output of the edit tool |
| Block the end of a turn | partial | OpenCode has no stop hook, so the plugin sends the report as a new message when the session goes idle, once per user turn, and never in `opencode run` |

## Install

```sh
buckets init --agent opencode
```

It writes:

- `.opencode/plugins/slopbuckets.ts`, the plugin. If you already have a file with that name, `init` leaves it alone and writes `.opencode/plugins/slopbuckets-hooks.ts` instead.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which OpenCode reads.

OpenCode loads every `.ts` file in `.opencode/plugins/` when it starts, so there is no config to edit. Restart OpenCode after `init`. OpenCode 2 also reloads plugins when the folder changes. When OpenCode loads a local plugin, it may create `.opencode/package.json` and `.opencode/node_modules/`; that is OpenCode, not slopbuckets.

The plugin starts the `buckets` command for each guarded tool call, so the machine needs it:

- a project install, `npm i -D slopbuckets`, which the plugin finds in `node_modules` of the project or a folder above it
- or a global install, `npm i -g slopbuckets`
- or the environment variable `SLOPBUCKETS_BIN` set to the path of the `buckets` command or of its `dist/index.js`

OpenCode runs plugins on Bun, and the plugin starts the CLI with the `node` on `PATH`. On Windows, a global npm install puts a `buckets.cmd` shim on `PATH`. The plugin runs the real `index.js` next to the shim with `node`, and goes through `cmd.exe` only when it cannot find it.

## How it works

The plugin holds no rules. For each guarded tool call it runs `buckets hook --agent opencode <event>`, writes one JSON object on stdin with the tool name, its arguments, the session id and the API line (`v1` or `v2`), and reads one JSON line back. The CLI maps the arguments and decides:

| OpenCode 1 tool | OpenCode 2 tool | What the CLI reads |
|---|---|---|
| `edit`, `write`, `multiedit` | `edit`, `write` | the file in `filePath` (OpenCode 1) or `path` (OpenCode 2) |
| `apply_patch`, `patch` | `patch` | the `*** Add File`, `*** Update File`, `*** Delete File` and `*** Move to` headers of `patchText` |
| `bash` | `shell` | `command`, run in `workdir` |

Other tools, such as `read`, run without a call to the CLI.

Before a guarded tool runs, `tool.execute.before` (OpenCode 1) or `ctx.tool.hook("execute.before")` (OpenCode 2) asks for `pre-tool-use`. When the answer is `{"decision": "deny", "reason": "..."}`, the plugin throws an error with the reason. OpenCode refuses the call and shows the reason to the model. That covers a write to any `buckets.lock.json`, a patch that touches it, a shell command that names it, and `buckets refresh` with anything but exactly `--web`. `buckets refresh --web > refresh.log 2>&1 &` passes.

After an edit tool, `tool.execute.after` or `execute.after` asks for `post-tool-use`. When a file has problems, the answer carries the report in `feedback`, and the plugin appends it to the tool output that the model reads next. After the `task` tool (OpenCode 1) or the `subagent` tool (OpenCode 2), the plugin asks for `subagent-stop` and appends a failing check to the subagent's result, so the main agent sees it.

At the end of a turn, OpenCode emits `session.idle`. OpenCode 2 also reports it as `session.status` with an idle status. The plugin then asks for `stop`, which runs the full `buckets check`. When the check fails, the plugin sends the report back as a user message that starts with `[slopbuckets]`, through `client.session.prompt` (OpenCode 1) or `ctx.session.prompt` (OpenCode 2). The agent reads it and either fixes the problems or explains them. The plugin does this at most once per user turn:

- after it sends a report, it skips the next idle events of that session
- a message that starts with `[slopbuckets]` does not start a new turn, and a message from you does
- it skips child sessions (sessions with a parent, which subagents use) and the idle event that follows a session error

## Limits

- OpenCode 1 and OpenCode 2 have separate plugin APIs. The file default-exports one object with `id`, a `server()` function for OpenCode 1 and a `setup()` function for OpenCode 2. OpenCode 1 reads this shape in 1.18.10 and newer; an older OpenCode 1 that accepts only function exports fails to load the plugin.
- Neither line has a hook that can stop the agent from ending its turn. The `session.idle` re-prompt is a workaround: the report arrives as a visible user message after the agent said it was done, and the extra turn costs model tokens.
- `opencode run` exits as soon as the session goes idle, so the re-prompt never happens there, and `opencode run` gets no end-of-turn check. Use `buckets init --git-hook` and `buckets check` in [CI](../ci) for scripted runs.
- Only the tools in the table above are guarded. A tool added by another plugin or an MCP server that writes files is not checked before or after it runs.
- The plugin fails open, like every slopbuckets integration. When the `buckets` command is missing, fails or prints something that is not JSON, the plugin allows the call, adds no feedback and sends no report. It warns once per session on stderr, in the OpenCode log and, in OpenCode 1, as a toast.
- Each call has a timeout: 10 seconds before a tool, 30 seconds after an edit and 60 seconds for the end-of-turn check. A call that times out counts as a failure and the tool runs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start OpenCode in the project folder.
2. Ask it to "write `{}` to buckets.lock.json". The write tool should fail with the reason from slopbuckets, which names the lock and `buckets refresh --web`.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. The output of the edit should end with the `buckets check --file` report.
4. In a project whose check fails, for example before the first `buckets refresh`, ask a short question in the TUI. After the answer, one `[slopbuckets]` message with the report should appear, and no second one.

You can also run a hook by hand from the project folder:

```sh
echo '{"api":"v1","tool":"write","args":{"filePath":"buckets.lock.json"}}' | buckets hook --agent opencode pre-tool-use
```

It prints `{"decision":"deny","reason":"..."}`. Use `"api":"v2"` and `"path"` for OpenCode 2.

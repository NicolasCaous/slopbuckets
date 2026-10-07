---
title: Cline
description: The hook scripts that buckets init writes in .clinerules/hooks/ for Cline, and why a blocked call ends the task.
---

# Cline

This page covers the Cline VS Code extension 4.x and the Cline CLI.

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | partial | `PreToolUse` stops the call, but Cline ends the whole task when a hook refuses |
| Feedback after edits | yes | `PostToolUse` hands the `buckets check --file` report to the model |
| Block the end of a turn | no | Cline has no hook that can keep the agent working |

## Install

```sh
buckets init --agent cline
```

It writes four scripts and the shared instructions:

- `.clinerules/hooks/PreToolUse` and `.clinerules/hooks/PostToolUse`, executable shell scripts for macOS and Linux
- `.clinerules/hooks/PreToolUse.ps1` and `.clinerules/hooks/PostToolUse.ps1`, PowerShell scripts for Windows
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Each script runs `buckets hook --agent cline <event>` and passes on the JSON Cline sends. A script that already exists and is not one of these is left alone, and `init` tells you what to add to it. If `.clinerules` is a single rules file, `init` changes nothing and asks you to move the rules into the folder first.

Then turn hooks on:

1. In VS Code, open the Cline settings and check "Enable Hooks" under Feature Settings.
2. Commit the scripts with the executable bit. On Windows, git does not record it by itself, so run `git update-index --chmod=+x .clinerules/hooks/PreToolUse .clinerules/hooks/PostToolUse`.
3. Do not run the Cline CLI with `--yolo` in this project, because that flag turns every hook off.

## How it works

Before each tool call, Cline runs `PreToolUse` with the tool name and its parameters. The hook reads the `editor` tool's `path`, the file headers of an `apply_patch` patch and each command of `run_commands`, plus the tool names of older Cline builds. When a call would write any `buckets.lock.json` or `buckets.config.json`, nested projects included, or a command runs `buckets refresh` with anything but exactly `--web`, the hook answers `{"cancel": true}` with an `errorMessage` that says why the task stopped. Every other call gets `{"cancel": false}`.

After an `editor` or `apply_patch` call, `PostToolUse` runs `buckets check --file` on each edited file inside the root bucket folder. When a file has problems, the hook answers with the report in `contextModification`, and Cline adds it to the next request so the model can fix the file.

Each command in a `run_commands` list is judged on its own, so `buckets refresh --web` followed by `git status` passes.

## Limits

- Cline has no way to refuse one tool call. `{"cancel": true}` ends the whole task, so the hook uses it only for a lock or config write and a plain `buckets refresh`. You start a new task after it.
- Nothing runs `buckets check` before the agent ends its turn. The rules in `AGENTS.md` ask the agent to run it, but nothing enforces that.
- The hooks fail open, like every slopbuckets integration. On a machine without the `buckets` command, the scripts print a warning and allow everything. Cline also lets a call through when a hook fails, times out or prints something that is not JSON.
- The Cline CLI with `--yolo` runs no hooks at all.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Open the project in VS Code with Cline and hooks turned on.
2. Ask Cline to "add an empty line at the end of buckets.lock.json". The task should stop with a message from slopbuckets that names the lock.
3. In a new task, ask it to add `import { x } from './x';` to a file under the root bucket folder. Cline should get the `buckets check --file` report after the edit and fix the import.

You can also run a hook by hand from the project folder:

```sh
echo '{"hookName":"PreToolUse","workspaceRoots":["'"$PWD"'"],"preToolUse":{"toolName":"run_commands","parameters":{"commands":"[\"buckets refresh\"]"}}}' | .clinerules/hooks/PreToolUse
```

It prints `{"cancel":true,...}`.

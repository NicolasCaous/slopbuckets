---
title: Cline
description: The hook scripts that buckets init writes in .clinerules/hooks/ for the Cline extension and CLI, and why refusing an edit ends the task.
---

# Cline

This page covers the Cline VS Code and JetBrains extension 4.x and the Cline CLI 3.x.

| Phase | Support | How |
|---|---|---|
| Warning on edit | yes | `PreToolUse` simulates `editor` and `apply_patch` and returns the pending list in `contextModification` |
| Pending list on other tools | yes | the same `PreToolUse` hook returns the current pending list for every other tool |
| Interrupt on an invalid config | partial | `PreToolUse` answers `cancel: true`, which ends the whole task |
| Interrupt at the end | no | Cline has no hook that can keep the agent working |
| Subagents | no | no subagent event can block |
| Compaction | no | Cline does not wire its compaction hook |

## Install

```sh
buckets init --agent cline
```

It writes:

- `.clinerules/hooks/PreToolUse`, an executable shell script for macOS and Linux
- `.clinerules/hooks/PreToolUse.ps1`, a PowerShell script for Windows
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Each script runs `buckets hook --agent cline pre-tool-use` and passes on the JSON Cline sends. When the `buckets` command is missing, the script prints `{"cancel":false}` and a note on stderr, so the tool runs. Each script carries the line `slopbuckets: written by`, which is how `init` tells it from your own. A script that already exists without that line is left alone, and `init` tells you what to add to it. When `.clinerules` is a single rules file instead of a folder, `init` installs nothing and tells you to move the rules into `.clinerules/<name>.md` first.

After it writes the scripts, `init` lists two steps:

1. Turn hooks on. In the extension, that is the "Enable Hooks" setting under Settings, Feature Settings. The CLI runs hooks unless you pass `--yolo`, which turns them off.
2. Commit `.clinerules/hooks/PreToolUse` with the executable bit. On Windows, git does not record it by itself, so run `git update-index --chmod=+x .clinerules/hooks/PreToolUse` before the commit.

slopbuckets 1.x also wrote `.clinerules/hooks/PostToolUse` and `PostToolUse.ps1`. `init` leaves them in place. They now do nothing but print a note on stderr, so delete them by hand.

## How it works

Cline sends each event as JSON on stdin. The CLI sends `tool_call: {id, name, input}` and the legacy `preToolUse: {toolName, parameters}`. The extension sends only the legacy block, with every value that is not a string encoded as a JSON string, which the hook decodes. The hook uses the first workspace root as the project folder, and `taskId` as the session.

- `PreToolUse` runs before every tool. For `editor` and `apply_patch`, and the older `write_to_file` and `replace_in_file`, it runs the `pre-edit` phase. `editor` carries `path`, `old_text` and `new_text`: without `old_text` it writes `new_text` as the whole file, and with `insert_line` the new text is unknown. `apply_patch` carries the patch text in `input`, and the hook applies its hunks to the files on disk. For every other tool it runs the `pre-tool` phase, and `run_commands` and `execute_command` also mark the session as one that may have changed files.
- With pending violations, the hook prints `{"cancel": false, "contextModification": "<pending list>"}`. Cline queues the text and sends it after the tool results, before the next model request. Cline cuts the context at 50 KB, so the hook cuts the list at 48,000 characters and ends it with a pointer to `buckets check`. With nothing to say, it prints `{"cancel": false}`.
- When the edit makes `buckets.config.json` worse, the hook prints `{"cancel": true, "errorMessage": "..."}`. Cline file hooks have no per-call deny, so this ends the whole task. The hook uses it for that case only.
- A subagent sends `agent_id` and `parent_agent_id`, and keeps its own memory of what was shown.

The CLI has a per-call deny in TypeScript plugins: a `beforeTool` that returns `{ skip: true, reason }` skips one call and sends the reason back as the tool error. A `.cline/plugins/` plugin may use it later. Plugins do not run in the extension.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Cline sets no variable with the project folder. If Cline runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- The extension dropped `PreToolUse` context from 4.0 to 4.1.10, and the CLI before 3.0.56. Use extension 4.1.11 or CLI 3.0.56 or later.
- `TaskComplete` runs after a completed task, but its output is ignored, so nothing runs `buckets check` before the agent stops. The `AGENTS.md` block tells the agent to run it, and `init` reminds you to add `buckets init --git-hook`.
- No file hook field approves a tool. `{"cancel": false}` is the neutral answer, and a crash of the hook prints it too.
- In the extension on Windows, Cline runs only the `.ps1` script, with `powershell -File`. The CLI on Windows finds both scripts, and the shell script steps aside there, so the hook runs once. PowerShell 7 on macOS or Linux skips the `.ps1` script for the same reason.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Turn on "Enable Hooks" in the extension, or start the CLI in the project.
2. Ask Cline to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. After the edit, it should get the pending list with `billing -> payments: private file`.
3. Ask it to empty the `purpose` of a bucket in `buckets.config.json`. Cline should end the task with `buckets: edit not applied, buckets.config.json would be invalid.`

By hand, from the project folder, send the `editor` call of the CLI that creates a file with the violation:

```sh
echo '{"taskId":"test","workspaceRoots":["'"$PWD"'"],"hookName":"PreToolUse","tool_call":{"id":"1","name":"editor","input":{"path":"src/billing/refund.ts","new_text":"import { charge } from \"../payments/client\";\n"}}}' | buckets hook --agent cline pre-tool-use
```

It prints `{"cancel":false,"contextModification":"buckets: 1 pending. ..."}` and writes nothing to `src/billing/refund.ts`. Cline has no stop event, so there is no stop to try. Delete `.buckets/sessions/test.json` afterwards.

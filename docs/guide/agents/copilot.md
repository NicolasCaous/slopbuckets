---
title: GitHub Copilot
description: The hooks that buckets init writes in .github/hooks/slopbuckets.json for Copilot CLI, the Copilot cloud agent and VS Code.
---

# GitHub Copilot

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `preToolUse` denies `create`, `edit` and `apply_patch` on a lock and a `bash` or `powershell` command that names it or runs plain `buckets refresh` |
| Feedback after edits | yes | `postToolUse` adds the `buckets check --file` report after the tool output, with Copilot CLI 1.0.87 or later |
| Block the end of a turn | yes | `agentStop` and `subagentStop` block once with the `buckets check` report |

## Install

```sh
buckets init --agent copilot
```

It writes:

- `.github/hooks/slopbuckets.json` with `preToolUse`, `postToolUse`, `agentStop` and `subagentStop` hooks. Each hook has a `bash` and a `powershell` command, so it runs on Linux, macOS and Windows. Both run `buckets hook --agent copilot <event>` only when the `buckets` command exists. Other files in `.github/hooks/` stay as they are.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Copilot reads

Copilot CLI loads the hook files of the repository when a session starts. Start a new session after `init`.

### Copilot cloud agent

The cloud agent reads hooks only from the default branch, and it runs on Linux without the `buckets` command. Without the CLI, the hooks skip themselves and nothing is checked. To use the hooks there:

1. Commit `.github/hooks/slopbuckets.json` and merge it into the default branch.
2. Install the CLI in `.github/workflows/copilot-setup-steps.yml`:

```yaml
name: Copilot setup steps
on: workflow_dispatch
jobs:
  copilot-setup-steps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g slopbuckets
```

### VS Code

VS Code has two agent engines. The Copilot engine reads the same `.github/hooks/` files and sends the same payload as Copilot CLI, so these hooks apply to it. The Local engine, still a preview, also reads `.github/hooks/` but sends a different payload. The adapter reads its snake_case fields too, but this was not tested.

## How it works

Copilot sends camelCase JSON on stdin. `toolArgs` is usually a JSON string, and for `apply_patch` it can be the patch text itself. The hook reads all three forms.

- `preToolUse`, with the matcher `edit|create|apply_patch|str_replace_editor|bash|powershell`. When `path` names a lock, also as a Windows path, with a stream suffix or with a trailing dot, or a patch header `*** Add File:`, `*** Update File:`, `*** Delete File:` or `*** Move to:` names one, the hook prints `{"permissionDecision": "deny", "permissionDecisionReason": "<reason>"}`. It does the same for a command that names the lock or runs `buckets refresh` with anything but exactly `--web`. Every other call gets no output, so Copilot's own permission rules still apply.
- `postToolUse`, with the matcher `edit|create|apply_patch|str_replace_editor`. The hook runs `buckets check --file` on each edited file and returns the report in `additionalContext`. Copilot caps that text at 10 KB, so a longer report is cut and ends with a note to run the check by hand.
- `agentStop`. The hook runs `buckets check` with nested projects. When it fails, it prints `{"decision": "block", "reason": "<report>"}` and Copilot keeps working. The next stop carries `stop_hook_active: true`, and the hook lets it through.
- `subagentStop` works the same way for a subagent. Its payload has no `stop_hook_active`, so the hook leaves a small mark per `agentId` in the system temp folder and lets the next stop of that subagent through. It never blocks twice in a row.

## Limits

- The hooks fail open, like every slopbuckets integration. Copilot denies a tool call when a `preToolUse` command exits with an error, and a shell that cannot find `buckets` exits with one, so each command first checks that `buckets` exists and does nothing when it is missing. A `.github/hooks/slopbuckets.json` from an older slopbuckets version had no such check and denied every call on a machine without the CLI. `buckets init --agent copilot` replaces those entries.
- Copilot lets a call through when a hook times out. The guard does no checking work, so it stays far below its 30 second timeout, but a very slow machine could let a call through.
- `postToolUse` feedback needs Copilot CLI 1.0.87 or later. Older versions ignore `additionalContext`, and the model hears about the problems from the stop report.
- The name of the path argument of `edit` is not documented. The hook reads `path`, `file_path` and the other usual names.
- Whether the cloud agent's hooks find the `buckets` command installed by `copilot-setup-steps.yml` was not verified.
- The built-in `general-purpose` subagent sends no `subagentStop`, so its work is checked only when the main agent stops.
- Copilot also reads hooks from `.claude/settings.json`. On Windows it runs them through PowerShell, where they fail, which is why `init` writes the native file.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Start `copilot` in the project.
2. Ask it to "run buckets refresh". Copilot should report that a hook denied the command, with the slopbuckets reason.
3. Ask it to add `import { x } from './x';` to a file under the root bucket folder. After the edit, Copilot should see the `buckets check --file` report and fix the import.

By hand, from the project folder:

```sh
echo '{"cwd":"'"$PWD"'","toolName":"bash","toolArgs":"{\"command\":\"buckets refresh\"}"}' | buckets hook --agent copilot pre-tool-use
```

It prints `{"permissionDecision":"deny",...}`.

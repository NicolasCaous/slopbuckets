---
title: Supported agents
description: Which AI coding agents slopbuckets has hooks for, what each one supports, and the buckets init command that sets it up.
---

# Supported agents

`buckets init` sets up Claude Code by default. `buckets init --agent <name>` sets up another agent instead, and a comma separated list, such as `--agent codex,cursor`, sets up several. `buckets init --agent auto` sets up every agent whose folder or file is already in the project, such as `.codex`, `.cursor` or `.github/hooks`.

Each agent also gets the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which tell the model the rules. The table shows what the hooks of each agent enforce on top of that, in three columns:

- Lock guard blocks lock writes and plain refresh. The hook refuses a write to any `buckets.lock.json` and a `buckets refresh` without `--web` before the tool runs.
- Edit feedback gives feedback after edits. After each edit, the model gets the `buckets check --file` report for the edited file.
- Turn check blocks the end of a turn. When `buckets check` fails, the agent cannot end its turn the first time it tries, and gets the report instead.

<div class="support-table">

| Agent | Lock guard | Edit feedback | Turn check | Install |
|---|---|---|---|---|
| [Claude Code](../claude-code) | yes | yes | yes | `buckets init` |
| [Codex CLI](./codex) | yes | yes | yes | `buckets init --agent codex` |
| [Cursor](./cursor) | yes | partial | yes | `buckets init --agent cursor` |
| [Gemini CLI](./gemini) | yes | yes | yes | `buckets init --agent gemini` |
| [GitHub Copilot](./copilot) | yes | yes | yes | `buckets init --agent copilot` |
| [Factory Droid](./factory) | yes | yes | yes | `buckets init --agent factory` |
| [Qwen Code](./qwen) | yes | yes | yes | `buckets init --agent qwen` |
| [Auggie](./auggie) | yes | yes | yes | `buckets init --agent auggie` |
| [Devin Desktop](./devin) | yes | partial | yes | `buckets init --agent devin` |
| [OpenCode](./opencode) | yes | yes | partial | `buckets init --agent opencode` |
| [Pi](./pi) | yes | yes | yes | `buckets init --agent pi` |
| [Amp](./amp) | yes | yes | yes | `buckets init --agent amp` |
| [Cline](./cline) | partial | yes | no | `buckets init --agent cline` |
| [Windsurf](./windsurf) | yes | no | no | `buckets init --agent windsurf` |
| [Kiro](./kiro) | partial | no | no | `buckets init --agent kiro` |
| [Goose](./goose) | yes | no | yes | `buckets init --agent goose` |
| [Crush](./crush) | yes | no | no | `buckets init --agent crush` |
| [Zed](./zed) | partial | no | no | `buckets init --agent zed` |
| [Aider](./aider) | no | partial | no | `buckets init --agent aider` |
| [Continue](./continue) | no | no | no | `buckets init --agent continue` |
| [Any other agent](./any-agent) | no | no | no | `buckets init --git-hook` |

</div>

Partial means the agent supports the behavior with a gap that its page names. Cline ends the whole task instead of refusing one call. Kiro does not block on Windows. Zed matches text with static rules in your user settings. Cursor and Devin may not hand the report after an edit to the model. OpenCode sends the end-of-turn report as a new message after the turn ends. Aider asks you before it sends the lint report to the model.

Some agent pages list points that were not checked against a real session, such as the argument names of a tool. Each page says which ones.

## When the CLI is missing

Every integration fails open. When the `buckets` command is missing, or a hook crashes or times out, the agent's call goes through and no check runs. This keeps an agent usable on a machine where slopbuckets is not installed, such as a teammate's laptop or a cloud agent without a setup step. So the hooks help the agent follow the rules, and the two checks below enforce them.

Two checks hold the rules whatever the agent does:

- `buckets init --git-hook` adds a git pre-commit hook that runs `buckets check`. It fails open too: without the CLI it prints a warning and lets the commit through.
- `buckets check` in [CI](../ci) runs on every pull request, whoever wrote the change.

## Several agents in one project

You can install more than one agent, such as `buckets init --agent claude,codex,cursor`. Each agent reads only its own files, with a few exceptions that its page describes: Cursor and Devin Desktop also read `.claude/settings.json`, so some checks run twice there and give the same answer. Running `buckets init` again adds only what is missing and keeps your own hooks.

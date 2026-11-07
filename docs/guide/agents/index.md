---
title: Supported agents
description: Which AI coding agents slopbuckets has hooks for, which hook phases each one supports, and the buckets init command that sets it up.
---

# Supported agents

`buckets init` sets up Claude Code by default. `buckets init --agent <name>` sets up another agent instead, and a comma separated list, such as `--agent codex,cursor`, sets up several. `buckets init --agent auto` sets up every agent whose folder or file is already in the project, such as `.codex`, `.cursor` or `.github/hooks`.

Every agent also gets the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`. The block says that the architecture lives in `buckets.config.json`, that the hooks warn when the code diverges from it, that fixing the code and editing the config are both valid, and that an agent without a stop hook runs `buckets check` before it finishes. The hooks add the checks below on top of that text. [Hooks](../hooks) explains the loop and every message.

Each hook runs `buckets hook --agent <name> <event>`, with the event names that `buckets hook --agent <name> --help` lists, such as `pre-tool-use` or `stop`. Claude Code's hooks leave out `--agent`. The adapter of each agent turns its events into the phases below. The agent pages show the commands of a global install. When you run the `buckets init` of a project dev dependency, every command starts with `node ./node_modules/slopbuckets/dist/index.js` in place of `buckets`, so the hooks run the version the project pins. `buckets init` warns when the command it writes would not run, and `buckets doctor` checks the commands of every installed hook.

The hooks find the project of each edited file from its path, so hooks installed at the root of a monorepo check every nested project. An agent reads hooks only from the folder its session opens, and `buckets init --root` installs them at the top of the git repository when you run `init` in a subfolder. See [Nested projects](../nested-projects#hooks-in-a-monorepo).

## The columns

- Warning on edit. Before a write, edit or patch runs, the `pre-edit` phase simulates the edit in memory and adds the pending list to the agent's context. The hook never answers "allow" with it, so the user's permission prompt stays in place. "After the edit" means the agent has no way to attach text before the tool, so the adapter checks the files as they are on disk after the tool and delivers the list with the post-tool event of the same call.
- Refuses a config-breaking edit. Before an edit runs, the hook denies it when it would make `buckets.config.json` invalid, or more broken than it is, and the edit never reaches the disk. Windsurf has only this hook: it refuses such an edit and shows no pending list.
- Interrupt at the end. When the turn ends, the `stop` phase runs the full check and blocks once, with every violation in full. The agent keeps working with that text as its next instruction. The check runs only when the session changed files, with an edit or a shell command, or still has pending violations. A turn that only read code ends without a check.
- Subagents. When a subagent ends, the `subagent-stop` phase does the same as `stop`, and the text goes to the subagent.
- Compaction. After the agent compacts its context, the `post-compact` phase clears the memory of what the hook already showed, so the next pending list shows every violation in full again. Without it, violations shown before the compaction keep coming back as one-line reminders.

<div class="support-table">

| Agent | Warning on edit | Refuses a config-breaking edit | Interrupt at the end | Subagents | Compaction | Install |
|---|---|---|---|---|---|---|
| [Claude Code](./claude-code) | yes | yes | yes | yes | yes | `buckets init` |
| [Codex CLI](./codex) | yes | yes | yes | yes | yes | `buckets init --agent codex` |
| [Cursor](./cursor) | after the edit | yes | yes | yes | no | `buckets init --agent cursor` |
| [Gemini CLI](./gemini) | after the edit | yes | yes | no | no | `buckets init --agent gemini` |
| [GitHub Copilot](./copilot) | yes | yes | yes | partial | no | `buckets init --agent copilot` |
| [Factory Droid](./factory) | after the edit | yes | yes | unverified | yes | `buckets init --agent factory` |
| [Qwen Code](./qwen) | yes | yes | yes | yes | yes | `buckets init --agent qwen` |
| [Auggie](./auggie) | after the edit | yes | yes | no | no | `buckets init --agent auggie` |
| [Devin](./devin) | after the edit | yes | yes | no | yes | `buckets init --agent devin` |
| [OpenCode](./opencode) | after the edit | yes | partial | yes | yes | `buckets init --agent opencode` |
| [Pi](./pi) | yes | yes | yes | no | yes | `buckets init --agent pi` |
| [Amp](./amp) | after the edit | yes | yes | unverified | no | `buckets init --agent amp` |
| [Cline](./cline) | yes | partial | no | no | no | `buckets init --agent cline` |
| [Windsurf](./windsurf) | no | yes | no | no | no | `buckets init --agent windsurf` |
| [Kiro](./kiro) | partial | partial | partial | no | no | `buckets init --agent kiro` |
| [Goose](./goose) | no | yes | yes | unverified | no | `buckets init --agent goose` |
| [Crush](./crush) | yes | yes | no | no | no | `buckets init --agent crush` |
| [Zed](./zed) | no | no | no | no | no | `buckets init --agent zed` |
| [Aider](./aider) | partial | no | no | no | no | `buckets init --agent aider` |
| [Continue](./continue) | no | no | no | no | no | `buckets init --agent continue` |
| [Any other agent](./any-agent) | no | no | no | no | no | `buckets init --git-hook` |

</div>

The table follows each agent's docs and source, and the payloads in the slopbuckets tests. No adapter has been tested in a live agent session yet, and each page says which behavior is inferred.

Partial and unverified cells, agent by agent:

- GitHub Copilot sends `subagentStop` for custom agents, but the built-in `general-purpose` agent sends no subagent events.
- Factory Droid has `SubagentStop`, but its docs do not say whether the block reason goes to the sub-droid or to the parent.
- Amp and Goose probably fire their stop event at the end of a subagent too. Their docs do not say so, and no live session confirmed it.
- OpenCode has no event that keeps the agent from ending its turn. The plugin sends the report as a new message when the session goes idle, once per user turn, and never in `opencode run`. A subagent's report goes at the end of the output of the `task` or `subagent` call that ran it.
- Kiro's hook prints the pending list on stdout. The Kiro IDE docs say it adds that text to the context, and Kiro CLI ignores it. Kiro CLI 3 can block the end of a turn, and the Kiro IDE lists its stop event as unable to block.
- Aider has no hooks. With `test-cmd: "buckets check"` and `auto-test: true`, Aider runs the check after each edit and asks you before it sends the output to the model.

Most agents can also refuse an edit before it reaches the disk. slopbuckets uses that only when the edit makes `buckets.config.json` worse: a config problem that was not there, or more of them. With an unreadable config the check cannot run, and every other warning would disappear until the end of the turn. When a shell command, a checkout or a merge already broke the config, its problems show in the pending list, and the hook denies only an edit that adds a problem. The agent can edit other files and fix the config one problem at a time. The "Refuses a config-breaking edit" column shows which agents can. Cline is partial because it refuses by ending the whole task, and Kiro because it does not block on Windows. Each agent page has the details.

To get the new text of an edit, a hook reads the file from disk only inside the project. It never reads a file outside the project, a link, a pipe or a device, or a file over 4 MB. The new text of an edit to such a file stays unknown, so the hook shows the current pending list and marks the session as one that changed files. An edit outside the project is not checked at all.

## When a phase is missing

Each adapter turns on the phases its agent supports and falls back when one is missing:

1. No context before the tool. The warning goes out after the edit, with the post-tool event, where the agent accepts context there. In practice this changes little, as the next section explains.
2. No stop that blocks. The agent relies on the `AGENTS.md` block, which tells it to run `buckets check` before it finishes, and on the git pre-commit hook that `buckets init --git-hook` installs.
3. No compaction event. The memory of what was shown is never cleared, and the one-line reminders keep going.

`buckets check` in [CI](../ci) holds the rules for every change, whatever the agent supports. [Guarantees](../guarantees) says what the check covers and what it does not.

## What every agent has in common

No agent puts hook text in front of the model before the tool runs, except by refusing the call. The model reads new context on its next request, which comes after the tool result. Claude Code places pre-tool context next to the tool result, and Qwen, Crush, Cline and Pi append it to the result or deliver it after the batch. So a pre-tool warning reaches the model at the same moment as a post-tool one. The pre hook still matters: it sees the edit before the file changes, which the simulation needs, and it can refuse the edit.

Some agents treat an "allow" answer as an approval that skips the user's permission prompt: Claude Code, Factory Droid, Crush, GitHub Copilot CLI and probably Devin. Cursor honors only "deny" today but has an open ticket to make "allow" count. So no slopbuckets hook prints an allow. It prints only the context field, a neutral answer such as Cursor's `{}` or Cline's `{"cancel": false}`, or nothing. Amp is the one exception: its plugin result has no neutral value, so the plugin answers `allow`, and Amp does not ask for approval by default.

Not every agent fails open when a hook fails. These cases refuse calls or keep the agent working when the hook itself fails:

- Claude Code on Windows without Git Bash, since 2.1.299: a `PreToolUse` hook that cannot start or exits with a code other than 0 or 2 blocks the call. The slopbuckets `PreToolUse` hook sets `"onFailure": "continue"`.
- Gemini CLI: a missing `buckets` command on bash exits 127, which Gemini turns into a deny for every matched call. Every slopbuckets command for Gemini ends with `; exit 0`.
- GitHub Copilot CLI, since 1.0.57: a `preToolUse` hook that crashes or exits with a non-zero code denies the call. The slopbuckets commands run `buckets` only when it exists, and the hook exits 0 on every path.
- Kiro CLI 3: a stop hook that exits 1 makes the agent continue. The slopbuckets hook exits 0 on any error of its own.
- Pi: an extension handler that throws blocks the tool. The slopbuckets extension catches every error.

The Auggie commands and the Cline scripts also exit 0 when `buckets` is missing, and the OpenCode, Pi and Amp plugins let every call run when the CLI is missing, crashes or takes too long, with one warning per session. A machine without the CLI is still the main gap: there the hooks do nothing, and the git hook and CI hold the rules.

Claude Code, Qwen Code, GitHub Copilot and Goose end the turn after 8 stop blocks in a row. Amp stops continuing after 5, and Cursor caps follow-ups per script. slopbuckets blocks once per turn anyway. It uses the agent's own flag where there is one, such as `stop_hook_active` or Cursor's `loop_count`. Where there is none, as for Copilot's `subagentStop`, Auggie, Kiro and Goose, it keeps a mark per session in `.buckets/sessions/` of the project, and the OpenCode, Pi and Amp plugins keep a flag per session that a new user message clears.

## Several agents in one project

You can install more than one agent, such as `buckets init --agent claude,codex,cursor`. Each agent reads its own files, with a few exceptions that its page names. Cursor, GitHub Copilot and Devin also run the hooks in `.claude/settings.json`. The Claude Code hook prints nothing for a Cursor or Devin payload, so those checks run once, but Copilot's payload looks like Claude Code's, so there the Claude Code hook runs next to the Copilot one. Continue loads `.claude/settings.json` without ever running it. Running `buckets init` again adds only what is missing and keeps your own hooks. `buckets uninstall --agent <name>` removes the hooks and files of one agent and keeps what the other agents share, and `buckets uninstall` removes what `init` installed for every agent.

## Upgrading from slopbuckets 1.x

`buckets init` refuses a 1.x `buckets.config.json`, which has `root`, `alias`, `layout` or `access`, and writes nothing until you rename it. After that, run `buckets init --agent <name>` again for each agent. It removes the 1.x entries it recognizes and adds the 2.0 ones, and prints `Updated the <agent> hooks in <file>` with the events it changed. The OpenCode, Pi and Amp plugins are rewritten in place. Two agents need a step by hand, which their pages describe: delete the 1.x `hooks` key in `.devin/hooks.v1.json` for [Devin](./devin), and the 1.x `PostToolUse` scripts in `.clinerules/hooks/` for [Cline](./cline).

A hook file from 1.x that still calls an event 2.0 does not have, such as `buckets hook post-tool-use` for Claude Code, does nothing: the hook exits 0 and prints a note on stderr that says to run `buckets init` again.

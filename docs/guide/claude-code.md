---
title: Claude Code
description: The skill and the 4 hooks that buckets init installs for Claude Code.
---

# Claude Code

`buckets init` installs a skill that teaches the agent the rules, and 4 hooks in `.claude/settings.json`. Each hook calls `buckets hook <event>`, so the hook logic ships with the CLI and works on Windows without bash. In a nested project, `init` skips both, because the hooks of the enclosing project already check nested projects.

| Hook | What it does |
|---|---|
| `PreToolUse` | denies any write to a lock and any `buckets refresh` other than exactly `buckets refresh --web`, even in bypass permission mode |
| `Stop` | runs `buckets check`, nested projects included, before the agent ends its turn |
| `SubagentStop` | runs the same check before a subagent hands back its work |
| `PostToolUse` | checks each edited file in its nearest project and reports its problems right away |

The exact settings, the input fields each hook reads and the JSON each one writes are on the generated [Claude Code hooks](../reference/hooks) page.

## The lock guard

`PreToolUse` is the only hard barrier inside the session. It denies the call when:

- the tool is `Edit`, `Write`, `MultiEdit` or `NotebookEdit` and the target is a lock: `buckets.lock.json` by name, also with a stream suffix or trailing dots, or any path that leads to the same file, such as an 8.3 short name, a hard link or a symbolic link. Nested locks count too.
- the tool is `Bash` or `PowerShell` and the command names a lock, also through a short name or a glob such as `bucket*`, or runs `buckets refresh` with anything but exactly the `--web` flag. Output redirections, a pipe or a trailing `&` after the flag are allowed

So `buckets refresh --web` passes, and so do the forms that run it in the background and keep its output, such as `buckets refresh --web > refresh.log 2>&1 &`, `buckets refresh --web 2>&1 | tee refresh.log` and `nohup buckets refresh --web > refresh.log 2>&1 &`. `buckets refresh`, `npx slopbuckets refresh`, `buckets refresh --web --yes` and `buckets refresh --web; buckets refresh` are denied, and so is `buckets refresh --web > buckets.lock.json`, because it names the lock. The deny decision holds even in bypass permission mode. The reason it returns tells the agent to ask for approval with `buckets refresh --web`. Because the shell rule is a text match, `cat buckets.lock.json` is denied too, and the agent reads the lock with the Read tool.

## The mandatory check

When the agent or a subagent is about to stop, the `Stop` or `SubagentStop` hook runs the full check from `CLAUDE_PROJECT_DIR`, every nested project included. If it passes, the agent stops. If it fails, the hook blocks once and hands back the report with a first line that depends on the exit code. With exit code 2, that line tells the agent to ask for approval with `buckets refresh --web`. On the second attempt to stop, the hook lets it through.

`Stop` runs at the end of every answer, even when the agent only talked. The analysis cache in `.buckets/cache/` keeps it fast: a project whose files did not change skips the adapter.

If a subagent's check fails because of something outside its task, it says so in its final message and the orchestrator decides.

## Feedback on every edit

After `Edit`, `Write` and `MultiEdit` on a file inside the root bucket folder of its project, `PostToolUse` runs `buckets check --file` on that file and returns the problems right away. The file belongs to its nearest project, which can be a nested one. It skips the orphan rule and the lock comparison, so a contract the agent is still wiring up does not trip it.

## A session above the projects

You can open Claude Code in a folder that holds several projects, such as `~/code`. Claude Code then does not read the `.claude/settings.json` of each project, so copy the `hooks` block from a project's `.claude/settings.json` into the `.claude/settings.json` of the folder you open, or into `~/.claude/settings.json`. The [hooks reference](../reference/hooks) shows the block.

When no project holds the session folder, each hook works on the project of the call:

- `PreToolUse` and `PostToolUse` use the project nearest to the file the tool writes. A file outside every project passes and nothing runs.
- A `Bash` or `PowerShell` command belongs to the project nearest to its working folder. The shell rules of the lock guard apply to every command, in a project or not.
- The lock guard denies a write to a lock inside any project, by name or through a link. For a hard link it compares the target with the locks of the project nearest to it, of the projects the session recorded and of the projects up to 3 levels below the session folder.
- The hooks record each project the session edits or runs a command in, keyed by the session id, in a small file in the system temp folder.
- `Stop` and `SubagentStop` run the full check in each recorded project and block once with one report that names the folder of each failing project. A project the session never touched is not checked. With nothing recorded, the agent stops without a check.

A session opened inside a project records nothing and works as the sections above describe.

## The skill

`buckets init` copies the skill to `.claude/skills/slopbuckets/SKILL.md`. It covers the folder, import and DMZ rules, nested projects, publishing with `.external.ts`, linking another project with `buckets link` and its dependencies on both sides, and these points:

- read the structure with `buckets inspect --json` before changing contracts, and export a picture with `buckets inspect --export mermaid` or `--export svg` when the human asks for one
- never edit any `buckets.lock.json`
- never run plain `buckets refresh`
- run `buckets check` before finishing a task
- with exit code 1, fix the violations or explain why it cannot
- with exit code 2, run `buckets refresh --web` in the background, send the link to the human with a summary of what changed and why, and wait for the command. With exit code 1 from it, ask the human what to change instead of retrying
- when `refresh --web` cannot ask for approval on the machine, such as in an SSH session, ask the human to run `buckets refresh` in a terminal
- with exit code 3, stop and show the human the message from the check

## Limits

The hooks fail open, like every slopbuckets integration. On a machine without the CLI installed, they fail to run `buckets` and block nothing. CI then holds the rules. `buckets init --git-hook` adds a git pre-commit hook that runs `buckets check` for every agent and every human, and the check in [CI](./ci) holds the rules too. The [threat model](./threat-model) lists what the hooks do not stop.

## Other agents

slopbuckets has hooks for other coding agents too, such as Codex CLI, Cursor, Gemini CLI and GitHub Copilot. `buckets init --agent codex` installs them instead of the Claude Code hooks, `--agent claude,codex` installs both, and `--agent auto` installs every agent whose folder is in the project. Every `buckets init` also writes the rules into a block of `AGENTS.md` and copies the skill to `.agents/skills/slopbuckets/SKILL.md`, which most agents read. [Supported agents](./agents/) compares what each agent's hooks enforce.

---
title: Windsurf
description: The Cascade hooks that buckets init writes in .devin/hooks.json for Devin Desktop, formerly Windsurf.
---

# Windsurf

This page covers Cascade, the older agent of Devin Desktop, which was called Windsurf before. The newer Devin Local agent has its own adapter, `buckets init --agent devin`.

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | yes | `pre_write_code` and `pre_run_command` exit with code 2, and Cascade does not run the action |
| Feedback after edits | no | Cascade has no hook after an edit that can talk to the model |
| Block the end of a turn | no | Cascade has no hook at the end of a turn |

## Install

```sh
buckets init --agent windsurf
```

It adds two hooks to the workspace hook file and writes the shared instructions:

- `hooks.pre_write_code` and `hooks.pre_run_command` in `.devin/hooks.json`, each with a `command` for macOS and Linux and a `powershell` command for Windows
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Cascade reads the legacy `.windsurf/hooks.json` only while `.devin/hooks.json` is missing or defines no hooks. So when your hooks live in `.windsurf/hooks.json`, `init` adds the slopbuckets hooks there and tells you, instead of creating a `.devin/hooks.json` that would hide yours. Your own hooks and comments stay as they were.

Hooks need no switch to turn on. Commit the hook file so everyone who opens the workspace gets it.

## How it works

Before Cascade writes a file, it runs `buckets hook --agent windsurf pre-write-code` with `tool_info.file_path` on stdin. Before it runs a command, it runs `buckets hook --agent windsurf pre-run-command` with `tool_info.command_line` and `tool_info.cwd`. When the file is any `buckets.lock.json`, or the command names the lock or runs `buckets refresh` with anything but exactly `--web`, the hook writes the reason on stderr and exits with code 2. Cascade then skips the action and shows the reason to the model. In every other case the hook exits with 0 and prints nothing.

The hooks set `show_output`, so you also see the reason in the Cascade panel.

## Limits

- After an edit, nothing reports the problems in the file. The model learns about them only if it runs `buckets check` itself.
- Nothing runs `buckets check` before Cascade ends its turn.
- The hooks fail open, like every slopbuckets integration. Any exit code other than 2 lets the action through, so when the `buckets` command is missing, or a hook crashes, Cascade goes on and nothing is blocked.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Open the workspace in Devin Desktop and pick Cascade.
2. Ask it to "run buckets refresh". Cascade should report that a hook blocked the command, with the slopbuckets reason.
3. Ask it to "add an empty line to buckets.lock.json". The write should be blocked the same way.

By hand, from the project folder:

```sh
echo '{"agent_action_name":"pre_run_command","tool_info":{"command_line":"buckets refresh","cwd":"."}}' | buckets hook --agent windsurf pre-run-command; echo "exit $?"
```

It prints the reason and `exit 2`.

---
title: Windsurf
description: The hook that buckets init writes in .devin/hooks.json for Windsurf, now Cascade in Devin Desktop, which can only refuse an edit.
---

# Windsurf

Windsurf is now Cascade, the older agent inside Devin Desktop. Devin Local, the newer agent, has its own page: [Devin](./devin).

| Phase | Support | How |
|---|---|---|
| Warning on edit | no | Cascade hooks have no way to add text without blocking |
| Pending list on other tools | no | same |
| Interrupt on an invalid config | yes | `pre_write_code` exits with code 2 and the reason on stderr |
| Interrupt at the end | no | the response hooks run after the fact and cannot block |
| Subagents | no | Cascade has no subagents |
| Compaction | no | Cascade has no compaction event |

## Install

```sh
buckets init --agent windsurf
```

It writes:

- one `pre_write_code` hook that runs `buckets hook --agent windsurf pre-write-code`, with a `command` for macOS and Linux, a `powershell` command for Windows that ends with `; exit $LASTEXITCODE`, and `show_output: true`. It goes in `.devin/hooks.json`, unless that file defines no hooks and the legacy `.windsurf/hooks.json` exists: Cascade reads the legacy file only while `.devin/hooks.json` defines no hooks, so `init` writes there and tells you to run it again if you move your hooks to `.devin/hooks.json`.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

`init` also reminds you that Cascade relies on the `AGENTS.md` block to run `buckets check` before it finishes, and suggests `buckets init --git-hook`. Hooks do not load in Restricted Mode.

## How it works

Cascade sends `pre_write_code` the file in `tool_info.file_path` and the changes in `tool_info.edits`, a list of `old_string` and `new_string`, and runs a workspace hook from the root of the repository, which the hook uses as the project folder. The hook applies the changes to the file on disk, and an empty `old_string` on a missing or empty file writes `new_string` as the whole file. When the edit makes `buckets.config.json` worse, the hook exits with code 2 and the reason on stderr, which Cascade shows the agent. Otherwise it exits 0 with no output and the edit runs.

Only stderr on exit 2 reaches the model. Stdout reaches the UI at most, and post hooks have no output the model reads, so the pending list has no way in. The agent learns about violations from `buckets check`, which the `AGENTS.md` block tells it to run before it finishes.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Windsurf sets no variable with the project folder. If Cascade runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- No warning on edit, no check at the end of a turn and no compaction event.
- Any exit code other than 0 or 2 lets the edit run, so a missing `buckets` command changes nothing.
- On Windows, Cascade runs the `powershell` command, and the command ends with `; exit $LASTEXITCODE` so that exit code 2 survives.
- Devin Local also runs Windsurf-format hooks, from a file its docs do not name, so this hook may fire there too.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

1. Open the project in Cascade, outside Restricted Mode.
2. Ask it to empty the `purpose` of a bucket in `buckets.config.json`. Cascade should refuse the edit with `buckets: edit not applied, buckets.config.json would be invalid.`
3. Ask it to run `buckets check` before it finishes. It should report every violation in full.

By hand, from the project folder, send a `pre_write_code` that empties the purpose of the `payments` bucket, here `Talks to the payment gateway`:

```sh
echo '{"agent_action_name":"pre_write_code","trajectory_id":"test","tool_info":{"file_path":"'"$PWD"'/buckets.config.json","edits":[{"old_string":"\"purpose\": \"Talks to the payment gateway\"","new_string":"\"purpose\": \"\""}]}}' | buckets hook --agent windsurf pre-write-code; echo "exit $?"
```

It prints the reason on stderr and exits with 2:

```
buckets: edit not applied, buckets.config.json would be invalid.
  buckets.payments.purpose: purpose is empty
  fix config: write one line in buckets.payments.purpose that says what payments does
exit 2
```

`buckets.config.json` stays as it was. An edit that does not break the config exits 0 and prints nothing, whatever violations the code has. Cascade has no stop event, so there is no stop to try.

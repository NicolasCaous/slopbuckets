---
title: Claude Code
description: The hooks that buckets init writes in .claude/settings.json for Claude Code, one per event, and the skill it copies.
---

# Claude Code

Claude Code supports every hook phase, so it is the default agent of `buckets init`.

| Phase | Support | How |
|---|---|---|
| Warning on edit | yes | `PreToolUse` with the matcher `*` simulates `Write` and `Edit` and returns the pending list in `additionalContext` |
| Pending list on other tools | yes | the same `PreToolUse` hook returns the current pending list for every other tool |
| Interrupt on an invalid config | yes | `PreToolUse` answers `permissionDecision: "deny"` when the edit makes `buckets.config.json` worse |
| Interrupt at the end | yes | `Stop` answers `decision: "block"` once, with every violation in full |
| Subagents | yes | `SubagentStop` does the same, and the reason goes to the subagent |
| Compaction | yes | `PostCompact` clears the memory of what was shown |

## Install

```sh
buckets init
```

It writes:

- the slopbuckets hooks in `.claude/settings.json`: one `PreToolUse` group with the matcher `*`, and one group each for `Stop`, `SubagentStop` and `PostCompact`. If the file already exists, `init` keeps your hooks and settings and adds only the missing entries.
- the skill in `.claude/skills/slopbuckets/SKILL.md`
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

The hooks run `buckets hook pre-tool-use`, `buckets hook stop`, `buckets hook subagent-stop` and `buckets hook post-compact`. The `PreToolUse` hook also sets `"onFailure": "continue"`. Running `init` again replaces older slopbuckets entries, such as the 1.x `PreToolUse` matcher and `PostToolUse` group, and prints `Updated the Claude Code hooks in .claude/settings.json` with the events it changed.

Claude Code reads `.claude/settings.json` when a session starts, so restart a running session after `init`. To remove the hooks, run `buckets uninstall --agent claude`, which deletes only the slopbuckets entries and the Claude Code copy of the skill and keeps your own settings. `buckets uninstall` alone removes everything `init` installed for every agent.

## How it works

Claude Code sends each event to the hook as JSON on stdin.

- `PreToolUse` runs for every tool. For `Write`, `Edit`, `NotebookEdit` and `MultiEdit` it runs the `pre-edit` phase, and for every other tool the `pre-tool` phase. `tool_input.file_path` is always absolute, with backslashes on Windows. `Write` carries the whole new file in `content`. `Edit` carries `old_string`, `new_string` and `replace_all`, and the hook applies them to the file on disk to get the new text: without `replace_all`, `old_string` must occur exactly once, and an empty `old_string` writes `new_string` into a missing or empty file. When the new text is unknown, as for `NotebookEdit` or an `Edit` that would not apply, the hook shows the current pending list and marks the session as one that changed files.
- With pending violations, the hook prints `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "<pending list>"}}` and no `permissionDecision`, so the permission prompt works as usual. When the edit makes `buckets.config.json` worse, it prints `permissionDecision: "deny"` with the reason in `permissionDecisionReason`, and the edit does not reach the disk. A config that was already invalid before the edit denies nothing: its problems show in the pending list.
- For `Bash` and `PowerShell`, the hook also marks the session as one that may have changed files.
- `Stop` runs the `stop` phase. It checks only when the session changed files or still has pending violations, and prints nothing otherwise. With violations, it prints `{"decision": "block", "reason": "<every violation in full>"}`. The next stop carries `stop_hook_active: true`, and the hook lets it through, so it blocks once. Claude Code also ends the turn by itself after 8 blocks in a row. A stop with no violation, after a turn that wrote a purpose or reason with `reason-generic` advice, prints `{"systemMessage": "buckets advice: ..."}` once with that advice. Claude Code shows it to you, and the turn ends.
- `SubagentStop` runs the `subagent-stop` phase. The payload has `agent_id`, so each subagent keeps its own memory in `.buckets/sessions/<session_id>-<agent_id>.json`. A subagent that changes files also marks the main session, so the main session checks at its own stop.
- `PostCompact` runs the `post-compact` phase, which clears the memory of what was shown. Its output is discarded.

Claude Code wraps `additionalContext` in a system reminder and places it next to the tool result, so the model reads a pre-tool warning after the tool ran, in the same place as a post-tool one. Each `additionalContext` string is capped at 10,000 characters. Longer text goes to a file, and the model gets a 2,000 character preview.

Cursor and Devin also run the hooks in `.claude/settings.json`. The Claude Code hook prints nothing when the payload comes from one of them, because each has its own slopbuckets hooks. Cursor payloads carry `cursor_version`, and Devin sets `DEVIN_PROJECT_DIR`.

## Limits

- After a project install, the hook command names the copy by the project folder that Claude Code sets, `node "$CLAUDE_PROJECT_DIR/node_modules/slopbuckets/dist/index.js" hook ...`, so the hook finds it whatever folder the agent is in. Claude Code runs hooks with bash, Git Bash on Windows, which expands the variable.
- On Windows without Git Bash, since Claude Code 2.1.299, a `PreToolUse` hook that cannot start or exits with a code other than 0 or 2 blocks the call. The `PreToolUse` entry sets `"onFailure": "continue"`, which Claude Code reads from 2.1.295, so a missing `buckets` command lets the call through. Older versions ignore the field.
- `Stop` does not run when the user interrupts the turn, and an API error fires `StopFailure`, which cannot block.
- GitHub Copilot CLI also runs the hooks in `.claude/settings.json`, and its payload looks like Claude Code's, so the Claude Code hook runs there too, next to the Copilot hooks.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules on a machine without the CLI too.

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Open Claude Code in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. The tool result should come with `buckets: 1 pending. Fix the code or edit buckets.config.json. Either is valid. Full detail: buckets check`, followed by `[NEW]` and `billing -> payments: private file`.
3. Let it end the turn without a fix. The stop hook should block once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send the `Write` call that made it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook pre-tool-use
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"Stop","stop_hook_active":false}' | buckets hook stop
```

The first command prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"buckets: 1 pending. ..."}}`. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints nothing, because the session changed no files. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

The [hooks reference](../../reference/hooks) lists every field the hooks read and write.

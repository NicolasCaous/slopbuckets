---
title: Codex CLI
description: The hooks that buckets init writes in .codex/hooks.json for Codex CLI, and the review Codex asks for before it runs them.
---

# Codex CLI

| Phase | Support | How |
|---|---|---|
| Warning on edit | yes | `PreToolUse` simulates `apply_patch` and returns the pending list in `additionalContext` |
| Pending list on other tools | yes | the same `PreToolUse` hook returns the current pending list for every other tool |
| Interrupt on an invalid config | yes | `PreToolUse` answers `permissionDecision: "deny"` with a non-empty reason |
| Interrupt at the end | yes | `Stop` answers `decision: "block"` once |
| Subagents | yes | `SubagentStop` does the same for the subagent |
| Compaction | yes | `PostCompact` clears the memory of what was shown |

## Install

```sh
buckets init --agent codex
```

It writes:

- `.codex/hooks.json` with one entry each for `PreToolUse`, `Stop`, `SubagentStop` and `PostCompact`, none with a matcher. Each one runs `buckets hook --agent codex <event>`, with the events `pre-tool-use`, `stop`, `subagent-stop` and `post-compact`, and a timeout in seconds: 60 for `PreToolUse`, 600 for the stop hooks and 30 for `PostCompact`. If the file already exists, `init` keeps your hooks and adds only the missing entries. It also replaces the 1.x entries, which had a `PreToolUse` matcher and a `PostToolUse` hook.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`, which Codex reads

When it changes the file, `init` reminds you that Codex runs project hooks only after two steps in Codex itself:

1. Trust the project when Codex asks, the first time you open it there.
2. Run `/hooks` and review and trust each slopbuckets hook.

Until then, the hooks do not run. Codex records trust against a hash of the whole hook definition, so any change to an entry, such as one a later `buckets init` makes, needs a new review.

## How it works

Codex sends each event to the hook as JSON on stdin.

- `PreToolUse` runs for every tool that fires hooks. For `apply_patch`, which Codex also matches as `Write` and `Edit`, it runs the `pre-edit` phase. Every file edit in Codex is `apply_patch`, with the patch text in `tool_input.command` and no file path. The hook reads the paths and the new content from the patch headers (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`) and the hunks, applies the hunks to the files on disk, and simulates every file of the patch in one check.
- For `Bash`, `exec_command` and the other shell names it runs the `pre-tool` phase and marks the session as one that may have changed files. MCP tools and the other local tools get the `pre-tool` phase too. Hosted tools such as web search do not fire hooks.
- With pending violations, the hook prints `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "<pending list>"}}`. It never prints `permissionDecision: "allow"`, `continue` or `suppressOutput`. When the patch makes `buckets.config.json` worse, it prints `permissionDecision: "deny"` with the reason in `permissionDecisionReason`. A deny always carries a reason, because Codex counts a deny without one as a failed hook.
- `Stop` and `SubagentStop` run the `stop` and `subagent-stop` phases, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "block", "reason": "<every violation in full>"}`, and Codex turns the reason into a new prompt. The next stop carries `stop_hook_active: true`, and the hook lets it through. Codex has no cap of its own, so this flag is the only loop guard.
- `PostCompact` runs the `post-compact` phase.

Codex records pre-tool context as developer messages before the tool runs, and the model reads them with the tool output. Each hook message is capped near 2,500 tokens. Longer text goes to a temporary file and the model gets the head and the tail.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. Codex sets no variable with the project folder. If Codex runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- The hooks run only in a trusted project, after you trust them in `/hooks`. A teammate who clones the project trusts them again on their machine. `--dangerously-bypass-hook-trust` skips the review for one run.
- `permissionDecision: "allow"` is not an approval in Codex. It only carries `updatedInput`, and without it Codex reports an unsupported decision. slopbuckets never prints it.
- Codex fails open when a hook exits with a code other than 0 or 2, so a missing `buckets` command or a crash lets the tool run.
- On Windows, Codex runs hook commands through `cmd.exe`, which finds the `buckets.cmd` that npm installs.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Open Codex in the project, trust it and trust the slopbuckets hooks in `/hooks`.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. The patch result should come with the pending list, starting with `buckets: 1 pending.`, and `billing -> payments: private file` under `[NEW]`.
3. Let it end the turn without a fix. The stop hook should block once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send the `apply_patch` call that adds it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: src/billing/refund.ts\n+import { charge } from \"../payments/client\";\n*** End Patch\n"}}' | buckets hook --agent codex pre-tool-use
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"Stop","stop_hook_active":false}' | buckets hook --agent codex stop
```

The first command prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"buckets: 1 pending. ..."}}`. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

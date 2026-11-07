---
title: GitHub Copilot
description: The hooks that buckets init writes in .github/hooks/slopbuckets.json for GitHub Copilot CLI and the Copilot cloud agent.
---

# GitHub Copilot

This page covers GitHub Copilot CLI and the Copilot cloud agent, which read the same hook files.

| Phase | Support | How |
|---|---|---|
| Warning on edit | yes | `preToolUse` simulates the edit and returns the pending list in `additionalContext`. When the model sees it is not documented |
| Pending list on other tools | yes | the same `preToolUse` hook returns the current pending list for every other tool |
| Interrupt on an invalid config | yes | `preToolUse` answers `permissionDecision: "deny"` with exit code 0 |
| Interrupt at the end | yes | `agentStop` answers `decision: "block"` once |
| Subagents | partial | `subagentStop` answers `decision: "block"` once per subagent. The built-in `general-purpose` agent sends no subagent events |
| Compaction | no | Copilot has only `preCompact`, which runs before the compaction |

## Install

```sh
buckets init --agent copilot
```

It writes:

- `.github/hooks/slopbuckets.json` with `"version": 1` and three hooks, none with a matcher: `preToolUse`, `agentStop` and `subagentStop`. Each one has a `bash` and a `powershell` command that runs `buckets hook --agent copilot <event>` only when the `buckets` command exists, with the events `pre-tool-use`, `agent-stop` and `subagent-stop`. The timeouts are `timeoutSec: 60` for `preToolUse` and 600 for the stop hooks. Running `init` again replaces the 1.x entries, which had a `preToolUse` matcher and a `postToolUse` hook.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

The cloud agent reads only `.github/hooks/*.json` in the cloned repository, runs only the `bash` or `command` field, and needs the `buckets` command on its machine. `init` reminds you of the two steps:

1. Commit `.github/hooks/slopbuckets.json`.
2. Install the CLI in `.github/workflows/copilot-setup-steps.yml`, for example with a step that runs `npm install -g slopbuckets`.

## How it works

Copilot sends each event as camelCase JSON on stdin, with `toolName` and `toolArgs`. `toolArgs` is a JSON string, or the bare patch text for `apply_patch`.

- `preToolUse` runs for every tool. For `create`, `edit`, `str_replace_editor` and `apply_patch` it runs the `pre-edit` phase. The argument names of the edit tools are not documented, so the adapter reads the paths and text under the usual keys, such as `path`, `file_text`, `old_str` and `new_str`, and treats a bare string as `apply_patch` text. For every other tool it runs the `pre-tool` phase, and `bash` and `powershell` calls also mark the session as one that may have changed files.
- With pending violations, the hook prints `{"additionalContext": "<pending list>"}` and no `permissionDecision`. When the edit makes `buckets.config.json` worse, it prints `{"permissionDecision": "deny", "permissionDecisionReason": "..."}` and exits with 0.
- `agentStop` runs the `stop` phase, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "block", "reason": "<every violation in full>"}`. The next stop carries `stop_hook_active: true`, and the hook lets it through. Copilot also ends the turn by itself after 8 blocks in a row.
- `subagentStop` runs the `subagent-stop` phase. Its payload has no loop flag, so the hook keeps a mark per session and `agentId` in `.buckets/sessions/` of the project to block once.

## Limits

- After a project install, the hook command names the copy relative to the project folder: `node ./node_modules/slopbuckets/dist/index.js`. GitHub Copilot sets no variable with the project folder. If GitHub Copilot runs a hook from another folder than the project folder, for example the folder the agent moved to with `cd`, the command does not find the copy and the hook does nothing.
- `permissionDecision: "allow"` suppresses the approval prompt since CLI 1.0.18, so the hook never prints it.
- Since CLI 1.0.57, a command `preToolUse` hook that crashes or exits with a non-zero code denies the call. The installed commands check that `buckets` exists and exit 0 when it does not, and the hook always answers a deny as JSON with exit code 0. Timeouts let the call through.
- On the cloud agent, a forced turn counts against the job timeout, and whether `preToolUse` context reaches the model there is unverified.
- Copilot CLI also loads hooks from `.claude/settings.json`, and no field tells its payload apart from Claude Code's. With Claude Code installed too, the Claude Code hook runs next to the Copilot one, and some checks run twice and give the same answer.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Start Copilot CLI in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. It should get the pending list with `billing -> payments: private file`.
3. Let it end the turn without a fix. `agentStop` should block once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send a `bash` call of the same session, which marks it as one that changed files, then the stop:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"sessionId":"test","cwd":"'"$PWD"'","toolName":"bash","toolArgs":"{\"command\":\"git apply refund.patch\"}"}' | buckets hook --agent copilot pre-tool-use
echo '{"sessionId":"test","cwd":"'"$PWD"'","stop_hook_active":false}' | buckets hook --agent copilot agent-stop
```

The first command prints nothing, because the session had no pending violations yet. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

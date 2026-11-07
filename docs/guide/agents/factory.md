---
title: Factory Droid
description: The hooks that buckets init writes in .factory/hooks.json for Factory Droid, and why the warning arrives after the edit.
---

# Factory Droid

| Phase | Support | How |
|---|---|---|
| Warning on edit | after the edit | `PostToolUse` returns the pending list in `additionalContext` |
| Pending list on other tools | after the tool | the same `PostToolUse` hook, which has no matcher, returns the current pending list |
| Interrupt on an invalid config | yes | `PreToolUse` on `Create`, `Edit` and `ApplyPatch` answers `permissionDecision: "deny"` |
| Interrupt at the end | yes | `Stop` answers `decision: "block"` once |
| Subagents | unverified | `SubagentStop` answers `decision: "block"` once. The docs do not say whether the reason goes to the sub-droid or to the parent |
| Compaction | yes | `SessionStart` with the matcher `compact` clears the memory of what was shown |

## Install

```sh
buckets init --agent factory
```

It writes:

- `.factory/hooks.json`, whose top level holds the events, with five hooks: `PreToolUse` with the matcher `Create|Edit|ApplyPatch`, `PostToolUse` with no matcher, `Stop`, `SubagentStop`, and `SessionStart` with the matcher `compact`. Each one runs `buckets hook --agent factory <event>`, with the events `pre-tool-use`, `post-tool-use`, `stop`, `subagent-stop` and `post-compact`, and a timeout in seconds: 60 for the tool hooks, 600 for the stop hooks, because the default is 60, and 30 for `SessionStart`. If the file already exists, `init` keeps your hooks and adds only the missing entries. It also replaces the 1.x entries, whose matchers named `MultiEdit` and `Execute`.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

Droid takes a snapshot of its hooks at startup and warns when they change outside `/hooks`. Restart Droid after `init`.

## How it works

Droid sends each event to the hook as JSON on stdin and sets `FACTORY_PROJECT_DIR`, which the hook uses as the project folder.

- `PreToolUse` with the matcher `Create|Edit|ApplyPatch` sees the edit before it runs. `Create` carries `file_path` and `content`. The fields of `Edit` and `ApplyPatch` are not documented, so the adapter reads the paths and text under every usual key, such as `file_path`, `old_str` and `new_str`, and patch text. The hook refuses an edit that makes `buckets.config.json` worse with `permissionDecision: "deny"` and exit code 0, and prints nothing otherwise. Droid documents no context field for `PreToolUse`, so the warning waits for `PostToolUse`. This hook keeps no memory, so nothing counts as shown before `PostToolUse` shows it.
- `PostToolUse` runs for every tool and delivers the warning in `hookSpecificOutput.additionalContext`. For the edit tools, the hook reads the files as they are on disk now and checks them as an edit. For every other tool, it shows the current pending list, and `Execute` also marks the session as one that may have changed files.
- `Stop` and `SubagentStop` run the `stop` and `subagent-stop` phases, only when the session changed files or still has pending violations. With violations, the hook prints `{"decision": "block", "reason": "<every violation in full>"}`. The next stop carries `stop_hook_active: true`, and the hook lets it through.
- `SessionStart` with `source: "compact"` runs after a compaction and stands in for `post-compact`. The hook ignores a `SessionStart` with any other source.

## Limits

- After a project install, the hook command names the copy by the project folder that Droid sets, `node "$FACTORY_PROJECT_DIR/node_modules/slopbuckets/dist/index.js" hook ...`, so the hook finds it whatever folder the agent is in. The command needs a shell that expands `$FACTORY_PROJECT_DIR`, such as bash.
- `permissionDecision: "allow"` can bypass the normal permission prompt, so the hook never prints it.
- Whether `PreToolUse` `additionalContext` reaches the model is unknown. Droid ships as a binary, so no source was readable. The adapter uses `PostToolUse` until a test in a live session shows the earlier path works.
- Exit codes other than 0 and 2 are non-blocking errors, so a missing `buckets` command lets the call through.
- `SubagentStop` has no agent id in its payload, and whether tool hooks fire inside sub-droids is not documented.
- The shell that runs hooks on Windows is not documented.
- Droid no longer has a `MultiEdit` tool.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Start Droid in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. After the edit, it should get the pending list with `billing -> payments: private file`.
3. Let it end the turn without a fix. `Stop` should block once with `buckets: 1 structure violation remains.`

By hand, from the project folder, write a file with the violation, send the `PostToolUse` of the `Create` that made it, then the stop of the same session:

```sh
printf "import { charge } from '../payments/client';\n" > src/billing/refund.ts
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"PostToolUse","tool_name":"Create","tool_input":{"file_path":"'"$PWD"'/src/billing/refund.ts","content":"import { charge } from \"../payments/client\";\n"}}' | buckets hook --agent factory post-tool-use
echo '{"session_id":"test","cwd":"'"$PWD"'","hook_event_name":"Stop","stop_hook_active":false}' | buckets hook --agent factory stop
```

The first command prints `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"buckets: 1 pending. ..."}}`. The second prints `{"decision":"block","reason":"buckets: 1 structure violation remains. ..."}`. A stop without the tool call before it prints nothing. Delete `src/billing/refund.ts` and `.buckets/sessions/test.json` afterwards.

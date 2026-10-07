---
title: Threat model
description: What the lock protects, what the skill, the hooks, the typed confirmation code and CI each do, and the attacks slopbuckets does not stop.
---

# Threat model

slopbuckets protects against an agent that takes shortcuts. It does not protect against a hostile agent. This page says what that means in practice.

## What the lock protects

`buckets.lock.json` records the last state a human approved: the bucket tree, the whole config with its [access rules](./concepts#access-rules), every DMZ file with the signature of each symbol it re-exports, the nested projects, and each link with the signatures of the symbols the linked project publishes. As long as the lock only changes through a human approval, an agent cannot change who depends on whom without a human seeing it. It can still write any code inside a bucket's `_/`, which is the point: the code is disposable, the contracts are not.

The shortcut slopbuckets expects is ordinary: an agent that needs a function from another part of the project imports it directly, or adds it to a contract and moves on. Each layer below catches that shortcut at a different moment.

## The layers

| Layer | What it does | What it relies on |
|---|---|---|
| The skill and the `AGENTS.md` block | Tell the agent the folder, import and DMZ rules, never to write the lock or the config, to run `buckets check` before finishing, and to ask for approval with `buckets refresh --web` | The agent reading and following it |
| Hook after an edit (`PostToolUse` in Claude Code) | Checks each edited file and hands the problems back right away | An agent with that hook, and the CLI installed |
| Hooks at the end of a turn (`Stop` and `SubagentStop` in Claude Code) | Run the full check before the agent or a subagent finishes, and block once when it fails | An agent with those hooks, and the CLI installed |
| Hook before a tool call (`PreToolUse` in Claude Code) | Denies writes to any lock and any `buckets.config.json`, any `buckets refresh` other than exactly `buckets refresh --web`, and `buckets update` without `--check` or `--json`, in Claude Code even in bypass permission mode | An agent whose hooks can refuse a call, and the CLI installed. The shell rule is a text match |
| The typed confirmation code | `refresh --web` writes the lock only after someone types, in a window of the operating system, the code shown on the review page | The agent not driving the desktop |
| CI | Runs `buckets check` with the CLI version the lock asks for, so an unapproved change fails the build | The pipeline being required before merge |
| Pull request review | A human reads the lock diff | The reviewer |

### The PreToolUse hook

It is the only hard barrier inside the agent session. This section describes the Claude Code hook. The hooks of the other agents call the same rules through `buckets hook --agent <name>`, and each [agent page](./agents/) says how far its agent lets a hook refuse a call. For file tools, it denies a target that is a lock or a `buckets.config.json` by name, also after Windows drops a stream suffix or trailing dots, and by identity: it compares real paths, devices and inodes, so 8.3 short names, hard links, symbolic links and linked folders are caught. For shell tools, it removes quotes, backticks, carets and backslashes, then denies any command that names a lock or a config literally, by short name or through a glob. It also splits the command into words and denies any call of `buckets refresh` other than exactly `buckets refresh --web`, also through `npx`, `npm exec`, Windows shims or `node <path>/index.js`. A call counts only where a command starts, so `git commit -m "explain buckets refresh"` passes. The same rule denies `buckets update` without `--check` or `--json`, because a human updates the CLI. It also denies an update whose arguments hold a command substitution, and it ignores a `--check` that comes after a `#` comment. The exact rules are on the [hooks reference](../reference/hooks#pre-tool-use).

### The typed confirmation code

The agent has the link to the review page and could call the approve endpoint itself. The approval still needs a code typed into a native window, which the agent cannot see or type into unless it controls the desktop. The code also ties the window to the state the human read. If the agent changes the project after the page loaded, reloads the page in its own client and approves the new state, the window opens, but the human's page still shows the old code and the server refuses it. See [The approval flow](./approval#what-makes-an-approval-count).

### The local servers

`buckets refresh --web` and `buckets inspect` listen only on `127.0.0.1` on a free port. They reject a `Host` header that is not their own address, which stops DNS rebinding, and an `Origin` header from another site. Every request that changes state must carry the server token from the page. The review page closes after 30 minutes without activity from the page itself, and 2 hours after it started in any case. Inspect answers only GET requests.

## The limits

These are known and accepted:

- **The shell rule is a text match.** An agent determined to get around it can write the lock or the config through a script that never names the file, or compute the name at run time. The hook stops an agent that reaches for the obvious command, not one that hides it. The same holds for `buckets update`: the guard prevents honest mistakes, and an agent set on updating can run `npm i -g slopbuckets` directly.
- **Input injection on the desktop.** On Windows, any process in the same desktop session can send keystrokes and clicks to another process's window. An agent that wants to can read the code from the page and type it into the confirmation window. macOS and Linux desktops have similar automation interfaces. The typed code stops an agent that takes the shortcut of calling the approve endpoint, and stops a human from approving a state other than the one they read. It does not stop a hostile agent with desktop control.
- **The server token only stops other web pages.** It protects against CSRF from another tab in the browser. It does not protect against local processes: the agent can fetch the page and read the token like a browser does.
- **Not every agent has hooks, and every hook fails open.** Claude Code, Codex CLI, Cursor, Gemini CLI, GitHub Copilot and several others have hooks that refuse a lock write. Some agents have weaker hooks or none, such as Aider and Continue, and nothing in their session stops a lock write. [Supported agents](./agents/) lists what each one gets. On a machine without the CLI installed, every hook lets the call through and blocks nothing, by design.
- **Linked code is not reviewed in the project that links it.** A link brings the source of another project, and that code runs in the project that links it. The human of the consumer approves the signatures the origin publishes, not the code behind them. A change inside the origin that keeps those signatures reaches a link in `link` mode right away, and a copy after `buckets link update`, which an agent may run, without an approval in the consumer. The rules and the lock of the origin still hold there. Review an origin like any other dependency, and use copy mode to keep a reviewed version in git.
- **The agent can edit everything else.** It can change the hook settings and the CLI in `node_modules`. The check in CI, with the CLI version from the lock, is the backstop for that, together with review.

The defense for every case above is the same: CI runs the check on every pull request, and a human reads the diff of every `buckets.lock.json` before merging. A lock change that no one asked for is the signal to look closer.

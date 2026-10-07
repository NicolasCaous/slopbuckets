---
title: Who runs which command
description: buckets check and buckets inspect are for anyone, buckets refresh --web is how an agent asks for approval, and only a human approves.
---

# Who runs which command

| Command | Who runs it | What it does |
|---|---|---|
| `buckets check` | the AI, the agent hooks and CI | checks the rules and compares each project with its lock |
| `buckets inspect` | anyone, the AI included | serves a read-only page with the map, contracts, traces, projects and approvals |
| `buckets inspect --json` | the AI | prints the same state as JSON and exits |
| `buckets refresh --web` | the AI, in the background | shows the changes on a local page, where a human approves them by typing a code into a window of the operating system |
| `buckets refresh` | a human, in an interactive terminal | shows the changes, asks for confirmation and writes the lock |
| `buckets link add`, `sync`, `update`, `remove` | the AI or a human | link the source of another project into a bucket, and keep the links current. They never write the lock |
| `buckets init` | a human | sets up a project, or a nested one |
| `buckets update` | a human | installs a newer slopbuckets, or a given version, the way the CLI was installed |
| `buckets update --check` | anyone | prints the installed and latest versions and the install command |

The AI can edit any file, DMZ files included. It cannot write the lock. When the AI changes a contract, `buckets check` fails until a human approves the change.

## buckets check

`buckets check` checks, in one run:

- the project settings the adapter needs
- the folder rules, nested projects included
- the content of every DMZ file, `.external.ts` files included
- the imports, including imports of linked projects, which must go through their `.external.ts` files
- the packages that linked files import, on the type checking side and the runtime side
- cycles in the bucket graph
- orphan contracts
- the bucket tree, the config, the DMZ files, the nested projects and the links against the lock, including the signature of every symbol a linked project publishes

It checks the current project and every project nested in it, each against its own lock. `--no-recursive` checks only the current project. See [Projects and links](./projects-and-links).

The text report is written for an AI reader. It groups rule violations by file, lists orphan chains and lock differences in their own sections, has one section per project when there are several, and tags each problem with its [rule id](../reference/rules) or the kind of difference. It ends with a summary line and a line that says what to do next.

`buckets check --json` prints the same result as a [JSON report](../reference/report) for scripts and CI.

`buckets check --file <path>` checks one file in its nearest project. It includes cycle detection, because a new import is what creates a cycle, but it skips the orphan rule and the lock comparison. The `PostToolUse` hook uses it after every edit.

### Exit codes

| Code | Meaning | What the AI does |
|---|---|---|
| 0 | everything passes | continues |
| 1 | a rule is broken | fixes it |
| 2 | the rules pass, but the project differs from the lock | asks for approval with `buckets refresh --web` |
| 3 | environment problem, such as a CLI version that differs from the lock | stops and tells the human |

When a rule is broken and the project also differs from the lock, the code is 1, because the AI has to fix the rule before anyone approves anything. With nested projects, the code is the worst one in this order: 3, then 1, then 2, then 0. The [environment codes](../reference/lock#environment-codes) list every case behind exit code 3.

## buckets refresh --web and buckets refresh

Both write the lock from the current state after a human approves it. Before anything else, both run the full check and refuse when a rule is broken. Both show the diff against the current lock: versions, config, buckets, nested projects, links, DMZ files, symbols and changed signatures. Both ignore a difference between the installed CLI or adapter and the versions in the lock, because approving is how a project moves to a new version. The version change shows up in the diff.

`buckets refresh --web` is the one an agent runs. It needs no terminal. It prints the diff and a link to a page on `127.0.0.1`, and waits. The human reads the page, clicks Approve and types the confirmation code from the page into a window of the operating system. [The approval flow](./approval) describes it step by step.

`buckets refresh` is the one a human runs in a terminal. It needs stdin and stdout to be a TTY, so an agent's shell cannot run it:

```text
buckets refresh needs an interactive terminal (stdin and stdout must both be a TTY), because a human must approve the contract changes.
AI agents must not run it. Run `buckets refresh --web` in the background instead, send the link it prints to the human, and wait for it to finish.
```

It asks `Approve and write buckets.lock.json? [y/N]`, once per project with changes. Only `y` or `yes` writes the lock. In Claude Code and the other agents whose hooks can refuse a tool call, the hook denies it before it even starts. See [Supported agents](./agents/).

The [lock differences](../reference/lock#lock-differences) page lists every kind of change and how each one looks in the check and in the diff.

## buckets inspect

`buckets inspect` reads the same state as the check and shows it on a page that updates while files change. It writes nothing and approves nothing. `buckets inspect --json` prints that state for an agent, and `buckets inspect --export svg|mermaid|html` prints the map, the bucket graph or the whole page as one HTML file. See [Inspect](./inspect).

## buckets update

`buckets update` reads the latest version of `slopbuckets` from the npm registry (the one in `npm_config_registry`, or `https://registry.npmjs.org`), prints it next to the installed version, and prints the command that installs it. The TypeScript adapter ships inside the CLI package, so this updates the adapter too.

The command depends on how the running CLI was installed. A global install uses `npm install -g`, `pnpm add -g`, `yarn global add` or `bun add -g`. A project dependency uses the package manager of the lockfile next to its `package.json` (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `bun.lock`), runs in that folder, keeps the dependency in `dependencies` or `devDependencies`, and pins the exact version, because the lock names one exact version. A copy that npx made, or a checkout of the repository, has nothing to update.

In a terminal it asks `Install slopbuckets <version>? [y/N]` and runs the command after `y`. `--yes` skips the question. Without a terminal and without `--yes`, it prints the command, installs nothing and exits with 1. `buckets update <version>` installs that version, such as the one a lock asks for. `buckets update --check` only prints, and `--json` prints this object without installing:

```json
{
  "installed": "1.1.0",
  "latest": "1.2.0",
  "updateAvailable": true,
  "install": { "scope": "global", "manager": "npm", "command": "npm install -g slopbuckets@1.2.0", "dir": null }
}
```

`scope` is `global`, `local` or `unknown`. For `local`, `dir` is the folder where the command runs. For `unknown`, `manager` and `command` are null.

Each lock records the CLI version that approved it, and `buckets check` stops with exit code 3 (`cli-version`) while the installed CLI differs. After an update, a human runs `buckets refresh` in each project, or an agent asks for it with `buckets refresh --web`. The diff shows the version change. To keep a project on the version its lock names, run `buckets update <version>` with that version instead.

### The update notice

When the registry has a newer version, every command except `buckets hook`, `buckets check --file` and `buckets update` first prints one line on stderr:

```text
slopbuckets 1.2.0 is available (installed 1.1.0). Run `buckets update`.
```

It goes to stderr, so the JSON and exports on stdout stay valid, and it comes first, so the link of `buckets refresh --web` stays the last line of a shared log. `buckets check --json` also puts it in its `update` field. The notice never changes an exit code. An agent that sees it finishes its task and leaves the update to the human.

The CLI asks the registry at most once every 24 hours, with a timeout of 1.5 seconds, and keeps the answer in `%LOCALAPPDATA%\slopbuckets` on Windows and in `$XDG_CACHE_HOME/slopbuckets` or `~/.cache/slopbuckets` elsewhere. A failure prints nothing. It never asks when the `CI` variable is set or with `SLOPBUCKETS_NO_UPDATE_CHECK=1`.

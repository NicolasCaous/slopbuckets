---
title: Getting started
description: Install the buckets CLI, set up a TypeScript project and approve its first state.
---

# Getting started

## Requirements

- Node.js 20 or newer.
- A TypeScript project with a `tsconfig.json` and the `typescript` package in its `node_modules`. The TypeScript adapter loads the compiler from the project, not from the CLI.

## Install

```sh
npm install -g slopbuckets
```

The package is `slopbuckets` and the command is `buckets`. The CLI is a global install because it is meant to support more languages than TypeScript. Each project pins the CLI version in its lock, so a global install does not drift between projects: `buckets check` refuses to run with a version that differs from the lock.

Check the install:

```sh
buckets --version
```

It prints the CLI version and the adapter version with its protocol number.

A coding agent can also do the install and the setup below, and then ask you to approve the first state. See [Install with an AI agent](./install-with-an-agent) for the prompt to paste.

## Set up a project

Run `buckets init` in the project folder:

```sh
cd your-project
buckets init
```

It asks 2 questions. Press Enter to keep the default in brackets:

| Question | Default | Config field |
|---|---|---|
| Root bucket folder | `root` | `root` |
| Import alias for internal imports (unique, so other projects can link this one) | `@<root folder>-` and 8 random characters, such as `@root-k3x9pm2a` | `alias` |

The alias is the prefix of every internal import, such as `import { logger } from '@root-k3x9pm2a/dmz/log/.self'`. `init` generates a new one for each project from lowercase letters and digits, without `0`, `o`, `1`, `l` and `i`, which are easy to confuse. So two projects that later [link each other](./projects-and-links#links) never share an alias. Keep the generated one unless you have a reason to pick your own. Projects set up with older versions use `@root`, which keeps working.

`init` also writes `"layout": {"default": "deny", "allow": ["<root>/*/*"]}`, so buckets may go two levels below the root bucket, such as `root/billing/invoices`. A human changes that limit in the file. See [Layout](./concepts#layout).

`buckets init --yes` takes the defaults without asking. Without `--yes`, `init` needs an interactive terminal when the project has no `buckets.config.json` yet.

Then it:

1. writes `buckets.config.json`, or keeps the existing one when it is valid
2. creates the root bucket folder with its `_/` folder, such as `root/_/`
3. asks the adapter to set up the project. The TypeScript adapter adds the alias to `compilerOptions.paths` in `tsconfig.json`, turns on `noUnusedLocals`, and adjusts `nest-cli.json` and the Jest config in `package.json` when they exist
4. installs the hooks of your coding agent. By default that is Claude Code: it merges the 4 [Claude Code hooks](./claude-code) into `.claude/settings.json` and copies the skill to `.claude/skills/slopbuckets/SKILL.md`
5. writes the slopbuckets rules in a block of `AGENTS.md` and copies the skill to `.agents/skills/slopbuckets/SKILL.md`, which most other agents read

To set up another agent, pass `--agent`. `buckets init --agent auto` installs the hooks of every agent whose folder or file is already in the project, such as `.claude`, `.codex` or `.cursor`. `buckets init --agent codex,cursor` names them. [Supported agents](./agents/) lists every agent and what its hooks enforce. Add `--git-hook` to also install a git pre-commit hook that runs `buckets check`, whatever agent or human makes the commit.

Running `buckets init` again changes nothing that is already set up. Inside a bucket's `_/` folder of another project, `buckets init` creates a [nested project](./projects-and-links#nested-projects) instead, with its own alias and lock, keeps the new folder out of the build of the enclosing project, and skips the hooks and the skill. A nested project needs its own `tsconfig.json`.

## Approve the first state

`buckets init` never writes the lock. Before the first approval, `buckets check` exits with code 2 and reports `lock-missing`:

```text
Lock differences
  Only a human approves these, with `buckets refresh` or `buckets refresh --web`.
  + lock-missing  buckets.lock.json
    buckets.lock.json does not exist yet, so no state has been approved. A human must run `buckets refresh` to create it.

buckets check: 1 lock difference.
Exit code 2: the rules pass, but the state differs from buckets.lock.json. ...
```

Approve the first state in your own terminal:

```sh
buckets refresh
```

With no lock yet, it shows the state it is about to approve: the CLI and adapter versions, every bucket and every DMZ file with its symbols. Answer `y` to write `buckets.lock.json`, and commit it with the rest of the project.

From then on, when an agent changes a contract, it asks you with `buckets refresh --web`: you get a link to a review page, read the changes, and type the confirmation code from the page into a window of your operating system. You can always run `buckets refresh` in a terminal instead. [The approval flow](./approval) shows both.

## Move code into buckets

Your code goes in `root/_/` at first. When a part of the project should be sealed, make it a bucket: create a folder next to `_/`, give it its own `_/`, and move the code there. The new bucket is a lock difference (`bucket-added`), so a human approves it with `buckets refresh`. Read [Concepts](./concepts) for the folder rules and how buckets talk to each other.

## Look at the result

`buckets inspect` opens a read-only page with the map of the buckets, the contracts between them and anything that needs attention. It never writes to the project. See [Inspect](./inspect).

## Next steps

- [Concepts](./concepts): buckets, the DMZ and the lock.
- [Who runs which command](./commands): `buckets check`, `buckets refresh --web`, `buckets refresh` and the exit codes.
- [Projects and links](./projects-and-links): several projects, and sharing code between them with links.
- [CLI reference](../reference/cli): every command and option.

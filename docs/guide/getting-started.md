---
title: Getting started
description: Install the buckets CLI, run init, and let an AI agent build the first architecture of the project.
---

# Getting started

## Requirements

- Node.js 20 or newer.
- A TypeScript or JavaScript project with a `tsconfig.json` in its folder. A JavaScript project needs one too, because slopbuckets does not read `jsconfig.json`. It does not need `allowJs`.
- The `typescript` package is optional. When the project has TypeScript 5 or 6, the TypeScript adapter resolves imports with it, so `paths` and workspaces work as they do in your build. With TypeScript 7, which has no JavaScript API, or with no `typescript` at all, the adapter uses the TypeScript 6 that slopbuckets installs with itself and reads the same `tsconfig.json`.

## Install

Install the CLI globally:

```sh
npm install -g slopbuckets
```

Or add it to the project, which pins the version for every teammate and for CI:

```sh
npm install --save-dev slopbuckets
```

The package is `slopbuckets` and the command is `buckets`. With a project install, run it as `npx buckets`. Check the install:

```sh
buckets --version
```

It prints the CLI version and the adapter version with its protocol number.

## Set up a project

Run `buckets init` in the project folder:

```sh
cd your-project
buckets init
```

It asks nothing about the project. It:

1. writes an empty `buckets.config.json`, or keeps the existing one:

   ```json
   {
     "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v2.json",
     "version": "2.0",
     "ignore": [],
     "projects": [],
     "buckets": {}
   }
   ```

2. adds `.buckets/` to `.gitignore`. That folder holds the analysis cache and the memory of each agent session.
3. installs the hooks of your coding agent. By default that is Claude Code, which gets its hooks in `.claude/settings.json` and the skill in `.claude/skills/slopbuckets/SKILL.md`.
4. writes a short block in `AGENTS.md`: the architecture is in `buckets.config.json`, the hooks warn when the code diverges, both fixes are valid, and agents run `buckets check` before they finish unless a slopbuckets stop hook runs it. It also copies the skill to `.agents/skills/slopbuckets/SKILL.md`, which Codex, Cursor, GitHub Copilot, OpenCode, Pi and Amp read.
5. sets up the merge driver: `.gitattributes` gets the line `buckets.config.json merge=slopbuckets`, and the git config of the clone gets the command, so two branches that each add a bucket or a dependency merge without a conflict. See [buckets merge-driver](./commands#buckets-merge-driver).

The hooks run slopbuckets the way `init` ran. After a global install they call `buckets hook ...`. When you run the `init` of a project install, as `npx buckets init`, they call `node ./node_modules/slopbuckets/dist/index.js hook ...`, so they need nothing on the PATH. For an agent that names its project folder in a variable and runs hooks in a POSIX shell, such as Claude Code with `$CLAUDE_PROJECT_DIR`, the command names the copy by that variable, so it works after the agent moves to another folder. A project with its own copy keeps the hooks on it, even when a global `buckets init` runs there later.

To set up another agent, pass `--agent`. `buckets init --agent codex,cursor` names them, and `buckets init --agent auto` sets up every agent whose folder or file is already in the project, such as `.claude`, `.codex`, `.cursor` or `GEMINI.md`. [Supported agents](./agents/) lists what each agent supports. Add `--git-hook` to also install a git pre-commit hook that runs `buckets check`, whoever makes the commit. It runs before any hook already there, which then runs unchanged.

`init` ends with warnings for what it cannot fix itself: no `tsconfig.json`, a hook command that is not on the PATH, a TypeScript version it cannot use, and a folder below the top of the git repository. In that last case, a session opened at the top of the repository does not read the hooks of this folder, and `buckets init --root` installs them at the top too. [Commands](./commands#buckets-init) lists each warning. `buckets doctor` checks the same things at any time.

Running `buckets init` again changes only what differs from the current version, and never overwrites an existing `buckets.config.json`. Each clone runs it once, because git does not commit the merge driver setting of the git config.

## Let the agent build the first architecture

Right after `init`, no file has a bucket, so `buckets check` reports one item with the folders of the project and their file counts:

```text
buckets check: 1 structure violation. Fix the code or edit buckets.config.json. Either is valid.

buckets.config.json: no buckets yet, 9 files are in no bucket
  src/app/** (1 file)
  src/billing/** (3 files)
  src/log/** (2 files)
  src/payments/** (3 files)
  fix config: design the first architecture as the SKILL section "The first architecture after buckets init" says: read what each folder does, put tests, scripts and generated files in ignore, and give each domain its own bucket
```

You do not write the config by hand. Paste the prompt that `init` prints into your agent. After a project install, it names `npx buckets check` instead:

```text
slopbuckets is set up in this project. Build its first architecture as the section "The first architecture after buckets init" of .agents/skills/slopbuckets/SKILL.md says, and run `buckets check` until it exits with 0.
```

The agent reads the skill and the code, splits the code into buckets with a purpose each, picks or creates the public files of each bucket, declares each dependency and each external package with a one-line reason, and puts tests and scripts in `ignore`. In an existing project, `buckets fix import-private` rewrites the imports of private files to go through the public files, which saves the agent most of the editing. [Install with an AI agent](./install-with-an-agent) describes every step.

Read the result before you commit it. Two shapes pass every rule and say nothing useful: one bucket with `src/**`, and a `shared` bucket that every other bucket depends on. [What the check guarantees](./guarantees) explains why.

## Commit

Commit `buckets.config.json`, `AGENTS.md`, `.agents/`, `.gitignore`, `.gitattributes` and the files `init` wrote for your agent, such as `.claude/`. From then on, the hooks keep the code and the config in step, and the git history of `buckets.config.json` is the history of the architecture.

## Look at the result

`buckets inspect` opens a read-only page with the bucket graph, the dependency matrix, the pending violations and the file tree. See [Inspect](./inspect).

## Coming from 1.x

There is no migration tool. `buckets init` refuses a 1.x config, which has `root`, `alias`, `layout` or `access`, says so, and writes nothing. Rename the old config, for example to `buckets.config.1x.json`, delete `buckets.lock.json` and `buckets.links.json`, and run `buckets init` again. It replaces the older hooks it recognizes, and [Supported agents](./agents/#upgrading-from-slopbuckets-1-x) lists the agents that need a step by hand. Then let an agent write the new config.

## Next steps

- [Concepts](./concepts): buckets, `public`, `dependsOn`, `packages`, `ignore` and the rules.
- [Hooks](./hooks): what the agent sees, and when.
- [Commands](./commands): every command, with examples.
- [CLI reference](../reference/cli): every command and option.

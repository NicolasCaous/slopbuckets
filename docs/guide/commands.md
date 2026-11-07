---
title: Commands
description: What each buckets command does, who runs it, and the exit codes, from init and check to doctor, show, fix import-private, fmt, merge-driver and uninstall.
---

# Commands

| Command | Who runs it | What it does |
|---|---|---|
| `buckets init` | a human or an agent, once per clone | writes the empty config, installs the hooks, the `AGENTS.md` block, the skill and the merge driver, and adds `.buckets/` to `.gitignore` |
| `buckets check` | agents, CI, the git hook | checks every rule and prints every violation in full |
| `buckets show <bucket>` | an agent | prints one bucket with its dependencies, packages, dependents and violations |
| `buckets fix import-private` | an agent, mostly while adopting slopbuckets | routes private imports through public files |
| `buckets fmt` | anyone | rewrites the config in its canonical form |
| `buckets inspect` | a human | serves a read-only page with the architecture and the violations |
| `buckets inspect --json` | an agent or a script | prints the same state as JSON and exits |
| `buckets doctor` | a human or an agent | checks how slopbuckets is installed and wired into the project |
| `buckets update` | anyone | installs a newer slopbuckets the way the CLI was installed |
| `buckets uninstall` | a human | removes what `init` installed |
| `buckets hook <event>` | the agent, through its hooks | runs one hook event with the JSON the agent sends |
| `buckets merge-driver` | git, through `.gitattributes` | merges `buckets.config.json` as a map |

Agents and humans edit `buckets.config.json` the same way they edit code. After `init`, only `buckets fmt`, the merge driver and `buckets fix import-private --public` write it.

Every command takes `-h` or `--help`, prints its usage and exits with 0. A command line it does not understand, such as an unknown option or a missing value, prints the usage on stderr and exits with 64, so a typo in CI does not read as a violation.

## buckets init

```sh
buckets init [--agent <name>[,<name>...] | --agent auto] [--git-hook | --no-git-hook] [--root]
```

`init` asks nothing. It:

- writes `buckets.config.json` with `"version": "2.0"`, `"ignore": []`, `"projects": []` and `"buckets": {}`, or keeps the config that is already there;
- adds `.buckets/` to `.gitignore`;
- installs the hooks of the agents named in `--agent`, which is Claude Code by default, or with `auto` every agent whose folder or file is in the project;
- writes the slopbuckets block in `AGENTS.md` and copies the skill, with the CLI version in its frontmatter;
- adds `buckets.config.json merge=slopbuckets` to `.gitattributes` and sets the merge driver in the git config of the clone, as [buckets merge-driver](#buckets-merge-driver) describes.

`--git-hook` also installs a git pre-commit hook that runs `buckets check` before any hook already there, which then runs unchanged. `--root` is for a project below the top of its git repository: it installs the agent hooks at the top folder too, where an agent session opened at the top reads them. Running `init` again changes only what differs from the current version, and never overwrites an existing `buckets.config.json`.

The hooks run slopbuckets the way `init` itself ran. A global install writes `buckets hook ...`. The `buckets init` of a project dev dependency writes `node ./node_modules/slopbuckets/dist/index.js hook ...`, the copy the project pins, or `node "$CLAUDE_PROJECT_DIR/node_modules/slopbuckets/dist/index.js" hook ...` for an agent that names its project folder in a variable and runs hooks in a POSIX shell: Claude Code, Crush, Devin and Droid. A copy run by its path from inside the project, such as `node tools/slopbuckets/dist/index.js init`, writes that path. A copy run by its path from outside the project writes `buckets hook ...`. In a project with its own copy in `node_modules`, a global or `npx` copy writes the path of the project copy too and says so, so `init` never replaces the hooks of a project install with a global `buckets`.

At the end, `init` warns about what it cannot fix itself. None of these warnings fails `init`:

- the folder has no `tsconfig.json`, which `buckets check` needs;
- the hooks run `buckets`, and `buckets` is not on the PATH, or they run a project copy that does not exist yet, so they would fail without a word;
- the hooks run a `buckets` on the PATH that is another slopbuckets version than the one running `init`;
- the project's TypeScript is a version slopbuckets does not use, such as TypeScript 7, so it resolves imports with its own TypeScript 6;
- the folder is below the top of its git repository, where a session opened at the top does not read its hooks; `--root` fixes that.

The last lines say what to do next. When the config has no buckets yet, they print the prompt that hands the first architecture to a coding agent, with the check command of the install, such as `npx buckets check` for a project copy. A 1.x config stops `init` before it writes anything: rename the old file and run `init` again. See [Getting started](./getting-started#set-up-a-project).

## buckets check

```sh
buckets check [--json | --format text|json|github|sarif] [--summary] [--base <ref>] [--no-recursive]
```

`check` reads the config, scans the imports of every file and prints every violation in full form, in the same order and words as the stop hook, then the environment errors and the [advice](../reference/rules#advice), notes on weak reasons and large `ignore` globs that never fail the check:

```text
buckets check: 1 structure violation. Fix the code or edit buckets.config.json. Either is valid.

billing -> payments: private file
  src/billing/invoice.ts:1 imports charge from src/payments/client.ts
  payments public: src/payments/index.ts
  fix code: import from src/payments/index.ts instead
```

With nothing to report it prints `buckets check: no structure violations.` It checks the nested projects listed in `projects`, recursively.

| Option | What it does |
|---|---|
| `--no-recursive` | checks only the current project, without the nested ones |
| `--summary` | prints only the number of violations per rule and per bucket, the advice per id and the environment errors, for a first look at a large project |
| `--json` | prints the result as JSON, the same as `--format json`; see [Check report](../reference/report) |
| `--format github` | prints the text report, and on stderr one `::error` line per violation, which GitHub Actions shows as an annotation on that line of the pull request; with `GITHUB_ACTIONS=true` the text and JSON formats print them too |
| `--format sarif` | prints a SARIF 2.1.0 log, for code scanning |
| `--base <ref>` | after the check, lists what changed in the architecture since the git ref: buckets, purposes, dependencies and packages with their reasons, public files and their exports; with `GITHUB_STEP_SUMMARY` set it also writes the list there as Markdown, and it never changes the exit code |

`--summary` prints text, so it does not combine with `--json` or `--format sarif`. With `--json` or `--format sarif`, the `--base` list goes to stderr, so stdout stays one JSON document. When a copy of the skill in the project is not the one of this CLI, `check` also prints one line on stderr that says to run `buckets init`.

### Exit codes

| Code | Meaning | What an agent does |
|---|---|---|
| 0 | no violation | finishes its task |
| 1 | at least one violation | fixes the code or edits the config, for each violation |
| 3 | environment problem: no config, a config `version` newer than the CLI, no `tsconfig.json`, no TypeScript that loads, or the adapter failed | fixes it if it is part of its task, otherwise shows it to the human |
| 64 | the command line is wrong | fixes the command |

Advice never changes the exit code. With nested projects, the exit code is 3 when any project has an environment problem, else 1 when any project has a violation, else 0. When a project could not be checked, the first line says so, such as `buckets check: could not check 1 project. Fix the problem below and run buckets check again.`, and the problem comes after the violations.

## buckets show

```sh
buckets show <bucket> [--json]
```

`show` prints one bucket, so an agent can read the part of the architecture it works on instead of the whole config: its purpose, its `files` globs, its public files, its dependencies and packages with their reasons, the buckets that depend on it with their reasons, and its violations in full. `<project>:<bucket>`, such as `packages/sdk:client`, names a bucket of a nested project. `--json` prints the same as JSON. It exits with 0 even when the bucket has violations, with 64 for a bucket the config does not have, and with 3 when the project cannot be checked.

```text
billing
  purpose: Issues and charges invoices
  files:
    src/billing/**
  public:
    src/billing/index.ts
  dependsOn:
    payments: Charges each invoice through the gateway
  packages:
    none
  dependents:
    app: Bills the order the program starts with
  violations: none
```

## buckets fix import-private

```sh
buckets fix import-private [--bucket <name>] [--public <file>] [--dry-run]
```

Adopting slopbuckets in an existing project often means hundreds of imports of files that are not public. `fix import-private` rewrites them. For every private import that the check reports, as `import-private` or inside a `dependency-undeclared`, it adds the missing named re-exports to the public file of the imported bucket, with `export type { }` for interfaces, type aliases and names that every import takes as types only, and points the importing statement at that public file. A public file holds one default export at most, so a private default goes through it under the name of its file: `import Hand from './icons/HandyHand'` becomes `import { HandyHand as Hand } from './icons'`, with `export { default as HandyHand } from './HandyHand'` in the public file. It keeps the style of each specifier: a tsconfig alias stays an alias, a relative path stays relative, and an extension stays.

- `--bucket <name>` fixes only the imports into that bucket. `<project>:<bucket>` names a bucket of a nested project.
- `--public <file>`, with `--bucket`, picks the public file the imports go through. When the file is not in `public` yet, `fix` adds it there.
- `--dry-run` prints the plan and writes nothing:

```text
Dry run, nothing was written. The plan:
src/billing/invoice.ts:1: '../payments/client.js' -> '../payments/index.js'
src/billing/invoice.ts:3: '../log/format.js' -> '../log/index.js'
note: billing still imports log without a dependsOn entry. Declare it with a reason, or move the code. fix import-private never edits dependsOn.
```

It never edits `dependsOn`, so an undeclared dependency stays reported for the agent to decide. It skips the imports of a bucket with `"public": null` and then exits with 1. Imports skipped for the same reason share one line with their count. Each file it writes keeps its line endings.

## buckets fmt

```sh
buckets fmt [--check]
```

`fmt` rewrites `buckets.config.json`, and the configs of the nested projects, in one canonical form: the top-level keys and the keys of each bucket in the order of the schema, the buckets and the entries of `dependsOn` and `packages` sorted by name, a two-space indent, and lists of two or more items one per line. Two edits of the same config then differ only where they change something. `--check` writes nothing, prints each file that is not formatted, and exits with 1 when there is one.

## buckets merge-driver

```sh
buckets merge-driver <base> <ours> <theirs>
```

Two branches that each add a `dependsOn` entry to the same bucket conflict in a plain text merge, because of the comma on the line before. The merge driver merges the three versions of the config as maps instead, so two branches that each add a bucket, a dependency, a package or a glob merge cleanly. It writes the result in the form of `buckets fmt`. Only a key that both branches changed in different ways is a conflict: the driver puts conflict markers around the top-level key or the bucket that holds it, and exits with 1.

`init` sets it up in two places. `.gitattributes` gets `buckets.config.json merge=slopbuckets`, which you commit. The git config of the clone gets `merge.slopbuckets.driver`, which git never commits, so each clone runs `buckets init` once. Git calls the driver itself. You never run it by hand.

## buckets inspect

```sh
buckets inspect [--json] [--no-recursive] [--export svg|mermaid|dot|html [--out <file>]]
```

`inspect` serves a read-only page on `127.0.0.1` that updates while files change. It stops with Ctrl+C, or by itself after 30 minutes without an open page. `--json` prints the snapshot for an agent and exits. `--no-recursive` shows only the current project, without the nested ones. `--export` prints the layered bucket graph as SVG, a Mermaid flowchart with the reasons on the edges, a Graphviz file, or the whole page as one offline HTML file, and exits without a server. `--out <file>` writes the export to a file instead of stdout. See [Inspect](./inspect).

## buckets doctor

```sh
buckets doctor
```

`doctor` checks how slopbuckets is installed and wired into the project, and says how to fix each problem it finds. It looks at:

- the `buckets` on the PATH, and whether a global copy and the copy the project pins are different versions;
- the `version` of the config, against the versions this CLI reads;
- the `tsconfig.json`, and which TypeScript resolves the imports;
- imports that do not resolve, by kind;
- the copies of the skill, against the version of this CLI;
- the commands that the agent hooks and the git pre-commit hook run, whether they exist, and whether the agent hooks run the same slopbuckets version as this CLI and the skill. A copy older than the `version` of the config fails, because it cannot check the project.

`doctor` and `init` look for `buckets` on the PATH of an agent's shell. They leave out the folder of the node that runs them and every `node_modules/.bin` folder, which Volta, npx and npm scripts add for their own child processes only.

```text
  + buckets.config.json has version "2.0", which slopbuckets 2.0.0 reads.
  + tsconfig.json exists.
  + The project has no typescript package, so slopbuckets resolves imports with its own TypeScript 6.
  - 1 import does not resolve (1 relative). Run the install of your package manager so workspace packages are linked, and check the "paths" of tsconfig.json. `buckets check` lists each one.
  + The skill in .agents/skills/slopbuckets/SKILL.md is the one of slopbuckets 2.0.0.

1 problem. Fix it and run `buckets doctor` again.
```

A line with `+` passed and a line with `-` is a problem. It exits with 1 when it found a problem, else 0.

## buckets update

```sh
buckets update [<version>] [--check] [--json] [--yes]
```

`update` reads the latest version of `slopbuckets` from the npm registry and installs it the way the running CLI was installed: globally with npm, pnpm, yarn, bun or Volta, or as a project dependency with the package manager of its lockfile. In a terminal it asks first. Without a terminal it installs only with `--yes`. After the install it reads the version on disk and reports when the package manager left the running copy alone. `--check` and `--json` print the installed and latest versions and the install command without installing. Agents may run it.

When the registry has a newer version, other commands first print one line on stderr with the new version and the installed one, and tell you to run `buckets update`. The line goes to stderr, so JSON on stdout stays valid, and it never changes an exit code. The CLI asks the registry at most once a day, and never when `CI` or `SLOPBUCKETS_NO_UPDATE_CHECK=1` is set.

## buckets uninstall

```sh
buckets uninstall [--agent <name>[,<name>...] | --all] [--config]
```

`uninstall` removes what `init` installed. With `--all`, the default, that is the hooks of every agent, the slopbuckets block of `AGENTS.md`, both copies of the skill, the `.buckets/` line of `.gitignore`, the `.buckets/` folder, the slopbuckets lines of the git pre-commit hook and the merge driver. With `--agent`, only the hooks and files of those agents go, and what the other agents share stays. Your own hooks and settings stay. `buckets.config.json` stays too, unless you pass `--config`. It exits with 1 when a step failed.

## buckets hook

```sh
buckets hook [--agent <name>] <event>
```

The hooks that `init` installs call this command. It reads the agent's JSON on stdin and answers in the agent's format. Each agent has its own event names, and `buckets hook --agent <name> --help` lists them. Inside the CLI each event maps to a phase: Claude Code's `pre-tool-use` runs pre-edit for `Write` and `Edit`, and pre-tool for every other tool. Without `--agent` it runs the Claude Code hook. An event the agent does not have, such as one from an older hook file, does nothing and exits with 0, with a note on stderr to run `buckets init` again. You do not run it by hand, except to test a hook. See [Hooks](./hooks).

The [CLI reference](../reference/cli) has the full help text.

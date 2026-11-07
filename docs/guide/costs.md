---
title: The costs of adoption
description: What slopbuckets asks of a project before the check passes, and what each cost buys.
---

# The costs of adoption

slopbuckets asks for more writing than a rule file with patterns. Every decision about the architecture is one line in `buckets.config.json`, the file at the root of the project that lists the buckets, and nothing is implied. This page lists what that costs before the check passes, and what each cost buys.

A bucket is a group of files with one job, matched by globs. A dependency is an import from one bucket into another. The hooks are the commands that `buckets init` installs in your coding agent, and they check each edit while the agent works.

## Every package, with a reason

Each bucket lists in `packages` every external module its files import: npm packages and Node built-ins such as `node:fs`. Type-only imports count. An import of a package the bucket does not list is `package-undeclared`, and a listed package that no file of the bucket imports is `package-unused`.

```json
"packages": {
  "react": "Renders the checkout pages",
  "zod": "Validates the invoice payloads of the public API",
  "node:fs": "Writes invoice PDFs to the export folder"
}
```

A real app has dozens of these per bucket at first. The agent writes them during the first architecture, and later each new package needs one line.

What it buys: the next agent knows why each bucket uses a package, and a package that only one bucket should touch, such as a database client, stays in that bucket unless an agent writes down why another one needs it.

## Every dependency, with a reason

`dependsOn` lists the buckets a bucket may import, each with a one-line reason. There is no wildcard and no default. A `log` bucket that 50 buckets import needs 50 entries, one in each of those buckets, and each says why that bucket logs. A purpose or reason under three words, or one that only names a bucket and a verb such as uses, gets a note under "buckets advice" in `buckets check`. Advice never fails the check.

What it buys: one reason per edge is the only way the next agent can tell a decision from an accident. A rule that allows `log` everywhere says nothing about why `billing` logs.

## Public files and rewritten imports

`public` names the files other buckets may import. Each public file holds only named re-exports, such as `export { charge } from './client'`. An import of any other file of the bucket is `import-private`. In an existing project, many imports point at private files, so adopting slopbuckets means writing the public files and moving those imports to them.

`buckets fix import-private` does both. It adds the re-exports each import needs to the public file of the imported bucket, and points the imports at it, keeping their alias or relative style. `--dry-run` prints the plan first:

```text
$ buckets fix import-private --dry-run
Dry run, nothing was written. The plan:
src/billing/refund.ts:2: '../payments/client' -> '../payments'
```

`export-unused` reports a name in a public file that no other bucket imports. A name that only tests or ignored files use counts as unused, so dead exports leave the interface.

What it buys: one file per bucket shows its whole interface, and everything else in the bucket can change without breaking another bucket.

## Every file in a bucket or ignored

A file in no bucket and not in `ignore` is `file-unowned`, and a file in two buckets is `file-overlap`. Right after `buckets init`, every file is unowned, and `buckets check` lists them grouped by folder. Tests, scripts and generated files go in `ignore`. An `ignore` glob that matches more than 20% of the source files gets advice, because those files fall outside every rule. Tests, scripts, fixtures and examples, by their path, do not count toward that share.

## A long pending list at first

The pending list is what the hook adds to the agent's context when the code and the config disagree. While it has items, the hook shows it before every tool call, each item in full once and then as a one-line reminder. During the first architecture, the list can hold hundreds of items, and each one costs a line before every tool call until the agent fixes it.

To keep that short, the agent builds the first architecture before it does other work. `buckets check --summary` prints only the number of violations per rule and per bucket, and the skill that `init` installs has a section on the first architecture.

## Install size

The `slopbuckets` package is about 1 MB. It depends on TypeScript 6, about 23 MB, which it uses to resolve imports when the project has no TypeScript 5 or 6 of its own. So the install takes about 24 MB. A project that keeps its own TypeScript 5 as a dev dependency cannot share one copy with slopbuckets, so its `node_modules` holds both compilers, about 48 MB together.

## Time per tool call

The hooks start a Node process for every tool call. In a project of 10,000 files, a hook before an edit takes about 81 ms, a hook before any other tool about 56 ms, and the stop hook at the end of a turn about 187 ms, all medians. See [Performance](./performance).

## What changes in a pull request

A pull request that changes the architecture changes `buckets.config.json` next to the code, and often a public file. A reviewer can read the raw JSON, or run `buckets check --base` with the target branch, which lists what changed in the architecture with its reasons:

```text
$ buckets check --base main
buckets check: no structure violations.

Architecture changes since main:
  Added the package `node:crypto` to `billing`: Generates the ids of refunds
```

The list covers buckets, dependencies and packages that came and went, public files, and the names they export. It does not change the exit code. With `GITHUB_STEP_SUMMARY` set, as in GitHub Actions, it goes to the summary of the step too.

No human approves the change. The review is the only human check, so read the reasons the agents write.

Two branches that each add a bucket or a dependency would conflict in plain JSON. `buckets init` sets up a git merge driver that merges the config as a map. It writes `.gitattributes`, which is committed, and a line in the git config of the clone, which is not, so each clone runs `buckets init` once.

## Next steps

- [Getting started](./getting-started) installs the CLI and lets an agent build the first architecture.
- [If you know another tool](./coming-from) compares slopbuckets with Nx, eslint-plugin-boundaries, Sheriff, dependency-cruiser and Tach.
- [What the check guarantees](./guarantees) says what a passing check means and what it cannot see.

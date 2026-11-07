---
title: What the check guarantees
description: What a passing buckets check means, what it cannot see, and where the hooks stop.
---

# What the check guarantees

slopbuckets 2.0 does not protect the config from agents. Agents edit it on purpose, and a change to the architecture is as valid as a change to the code. What slopbuckets guarantees is that the code and the config agree, and that every dependency has a written reason.

## When `buckets check` exits with 0

- Every file that git lists, with an extension of the adapter, is in exactly one bucket or in `ignore`.
- Every relative import, every import that matches a `paths` pattern and every import of a workspace package resolves to a file.
- Every import from one bucket to another goes through a public file of the target bucket.
- Every public file holds only named re-exports of its own bucket, or, in a bucket with `external`, of the buckets it declares.
- Every import from one bucket to another is declared in `dependsOn` with a one-line reason, and every declared dependency has at least one import.
- Every npm package and Node built-in that a bucket file imports, type-only imports included, is declared in the `packages` of its bucket with a one-line reason, and every declared package has at least one import.
- The `dependsOn` graph has no cycle, so the code has none between buckets either.
- Every name in a public file is imported by another bucket, unless the bucket declares `external`.
- No file of a bucket imports an ignored file, and no `import()` or `require()` hides its target behind a computed path.
- Every glob matches something, and every nested `buckets.config.json` is listed in `projects`.

Advice does not change the exit code, so a passing check can still print notes on short reasons or a large `ignore` glob.

## What the check does not see

### Coupling without imports

The check follows imports. Two buckets that share the same database table, event topic, environment variable, cache key or dependency injection token are coupled, and no import shows it. The check passes, and the config says nothing about that dependency.

The practice the skill teaches: each table, topic or key has one owner bucket, and other buckets reach it through the public file of that owner. Then the coupling becomes an import, and the check sees it.

### Giant buckets

A single bucket with `"files": ["src/**"]` and `"public": null` passes every rule. So does a project split into two buckets where one holds almost everything. The check measures whether the code follows the config, not whether the config describes a useful architecture. A bucket that every other bucket depends on, such as `utils` or `shared`, passes too.

Read the config the agents write. [Install with an AI agent](./install-with-an-agent#what-to-look-for-in-the-result) lists the shapes to question, and the "May want to split" note of [Inspect](./inspect#details-panel) points at buckets whose dependents use disjoint parts of the interface.

### Reasons that say nothing

The check requires a non-empty one-line reason for each dependency and each package. The `reason-generic` advice flags reasons under three words and reasons that only name a bucket with a generic verb, such as `"Uses log"`, and purposes that hold only bucket names and filler words like does, job, stuff, things and handles, as in `"Does the billing job"`. It cannot tell a precise reason from a long vague one. Reasons are for the next agent, and only a reader can judge them.

### What the scanner cannot read

- An import that does not resolve and is not relative, not a `paths` match and not a workspace package, such as a package that is not installed, counts as a package under its name. The check does not verify that the package exists.
- An absolute path or a package.json `#` import that does not resolve is not reported.
- Code loaded without `import` or `require`, such as a file path read at run time, a plugin loader or a framework that finds files by convention, is invisible.
- Files that git ignores, or with an extension the adapter does not read, are not in the project at all.

## Where the hooks stop

The hooks help agents keep the code and the config in step during a session. They are not a security boundary.

- Agents differ. Some get the warning after the edit, some have no stop that blocks, and some have no hooks at all. [Supported agents](./agents/) has the table.
- A hook that cannot run, because the CLI is missing or the hook times out, lets the call through in most agents. A few fail closed on some errors, and their pages say which. `buckets init` and `buckets doctor` warn when the command the hooks run is not installed.
- A config with a `version` newer than the installed CLI is not checked. The hooks say so once and let the agent work, and `buckets check` exits with 3.
- A human can commit without any hook.
- A hook reads files only inside the project. It never reads a file outside the project, a link, a pipe or a device, or a file over 4 MB. It cannot simulate an edit to such a file, so it shows the current pending list instead, and the stop checks the files on disk. An edit outside the project is not checked.
- Pre-edit denies only an edit that makes `buckets.config.json` worse. A config that a shell command, a checkout or a merge already broke shows in the pending list until the agent fixes it.
- The check ignores a `.buckets/` cache that arrived in a commit or a pull request. Each cache file carries a random key kept in the git folder of the clone, and no commit carries that key.

`buckets check` in [CI](./ci), and the git pre-commit hook from `buckets init --git-hook`, hold the rules whatever the agent does.

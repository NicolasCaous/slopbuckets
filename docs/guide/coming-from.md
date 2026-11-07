---
title: If you know another tool
description: How Nx module boundaries, eslint-plugin-boundaries, Sheriff, dependency-cruiser and Tach map to slopbuckets, what differs, and when to keep the tool you have.
---

# If you know another tool

Several tools check which part of a project may import which. This page maps their ideas to slopbuckets and says when the tool you have fits better.

In slopbuckets, the architecture lives in `buckets.config.json` at the root of the project. A bucket is a group of files with one job, matched by globs. `dependsOn` lists the buckets a bucket may import, `packages` lists the npm packages and Node built-ins it imports, and every entry in both has a one-line reason. `public` names the files other buckets may import. Hooks in the coding agent check each edit against the file while the agent works.

## What every one of them differs in

Three things set slopbuckets apart from all the tools below.

- **One entry per edge.** The other tools write rules with tags, patterns or regular expressions, so one rule covers many imports. slopbuckets has no wildcard. Each pair of buckets and each package is one entry with a reason, so the config says why `billing` imports `log`, and not only that it may.
- **Both fixes are valid, and no human approves anything.** In the other tools, a violation means the code is wrong, and a change to the rules goes through a human, often through code review with an owner on the rules file. slopbuckets tells the agent that fixing the code and editing the config are both valid, and the agent picks one. The review of the pull request is the only human check.
- **It runs inside the agent.** The other tools report in the editor, in `eslint` or in CI, after the code is written. slopbuckets reports in the agent's context at each edit and blocks the end of the agent's turn once when something is left, and `buckets check` covers CI.

slopbuckets checks TypeScript and JavaScript only, and it is not an ESLint plugin.

## Nx module boundaries

The `@nx/enforce-module-boundaries` ESLint rule checks imports between Nx projects. Each project has tags in its `project.json`, such as `scope:billing` or `type:feature`, and `depConstraints` in the ESLint config say which tags may depend on which.

| Nx | slopbuckets |
|---|---|
| an Nx project, a library or an app | a bucket, any set of files that globs pick |
| tags and `depConstraints` | `dependsOn`, one entry per bucket with a reason |
| the entry file of a library, reached through its path alias | `public`, one file or a list |
| `bannedExternalImports` and `allowedExternalImports` | `packages`, every package listed with a reason |

A bucket is usually smaller than an Nx library. It is a folder inside one project, and splitting a bucket only changes globs, with no new `project.json` or path alias. In an Nx workspace, each Nx project can have its own `buckets.config.json`, listed in `projects` of the root config. See [Nested projects](./nested-projects).

Keep Nx boundaries when your boundaries are the Nx projects themselves and you want a person to own the tag rules.

## eslint-plugin-boundaries

eslint-plugin-boundaries is an ESLint plugin. Its settings define element types by path pattern, and its rules say which element types may import which (`element-types`), which files of an element others may import (`entry-point`), which external packages an element may import (`external`), and that every file belongs to an element (`no-unknown-files`).

| eslint-plugin-boundaries | slopbuckets |
|---|---|
| an element type, matched by a pattern that can capture folder names | a bucket, matched by globs, with a name of its own |
| `element-types` rules with allow and disallow | `dependsOn` with a reason per bucket |
| `entry-point` | `public`, which also must hold only named re-exports |
| `external` | `packages`, with a reason per package |
| `no-unknown-files` | `file-unowned` |

One pattern with a captured folder name can describe all the feature folders at once. slopbuckets asks for one bucket per folder instead, each with its own purpose and reasons.

Keep eslint-plugin-boundaries when you want the errors in the editor through ESLint, or rules that cover many folders with one pattern.

## Sheriff

Sheriff (`@softarc/sheriff-core`) checks TypeScript projects, with an ESLint plugin and a `sheriff verify` command. A module is a folder, and its `index.ts` is its public API. A deep import into another module is an error. `sheriff.config.ts` gives modules tags by path and says in `depRules` which tags may depend on which.

| Sheriff | slopbuckets |
|---|---|
| a module, a folder with an `index.ts` | a bucket, any set of files that globs pick |
| `index.ts` as the public API | `public`, one file or a list, holding only named re-exports |
| tags and `depRules` | `dependsOn`, one entry per bucket with a reason |

Sheriff and slopbuckets agree that each part of the code has one public entry. slopbuckets also asks that the public file holds nothing but named re-exports, and reports each exported name that no other bucket imports.

Keep Sheriff when you want the encapsulation rules in ESLint and the dependency rules written once per tag.

## dependency-cruiser

dependency-cruiser builds the dependency graph of a JavaScript or TypeScript project and checks it against rules in `.dependency-cruiser.js`. Rules are `forbidden`, `allowed` or `required`, and they match paths with regular expressions. They can also forbid cycles, orphan files, imports that do not resolve and kinds of dependencies, such as dev dependencies in production code. It draws the graph in several formats.

| dependency-cruiser | slopbuckets |
|---|---|
| `from` and `to` paths as regular expressions | buckets by glob, and `dependsOn` with a reason per bucket |
| a rule against `circular` | `config-cycle`: the config may not declare a cycle, so the code has none |
| a rule with `couldNotResolve` | `import-unresolved` |
| rules on dependency types and paths in `node_modules` | `packages`, every package with a reason |
| graphs in dot, mermaid and other formats | `buckets inspect --export svg`, `mermaid`, `dot` or `html` |

dependency-cruiser can express rules that slopbuckets has no field for, such as orphan files or dev dependencies imported by production code. slopbuckets has fewer kinds of rule, and each of them gives the agent a fix in the code and a fix in the config.

Keep dependency-cruiser when you need those other kinds of rule, or a graph of a codebase without declaring every edge.

## Tach

Tach checks Python projects. `tach.toml` lists modules, each with `depends_on`, and interfaces say which names a module exposes. `tach check` reports imports that the file does not allow.

| Tach | slopbuckets |
|---|---|
| a module with a path | a bucket with globs |
| `depends_on` | `dependsOn`, with a reason per bucket |
| an interface that exposes names | `public`, a file of named re-exports |

The model is the closest to slopbuckets of the tools on this page. Tach is for Python and slopbuckets is for TypeScript and JavaScript, so the choice follows the language.

## Running two tools

slopbuckets does not read or change ESLint or any other tool's config, so it can run next to any of these tools. If both check the same boundaries, an agent that edits `buckets.config.json` to allow an import still fails the other tool, and the "fix config" answer stops being valid. Pick one tool for the boundaries between parts of the code, and keep the other for what slopbuckets does not check.

## Next steps

- [The costs of adoption](./costs) lists what slopbuckets asks of a project before the check passes.
- [Concepts](./concepts) explains each field of the config and every rule.
- [Getting started](./getting-started) installs the CLI and lets an agent build the first architecture.

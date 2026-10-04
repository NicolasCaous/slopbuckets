---
title: Writing an adapter
description: How the CLI splits the work with a language adapter, and what an adapter must answer.
---

# Writing an adapter

The CLI applies every rule that does not depend on a language: folders, the bucket graph, cycles, orphans and the lock. A language adapter reads the source code and reports exports, imports and type signatures back to the CLI as data. The adapter applies no rules. It only describes what it found.

The TypeScript adapter, `adapters/ts/` in the repository, ships inside the CLI. Today it is the only one: the `adapter` field of the config accepts only `"ts"`, and the CLI calls the adapter inside its own process. Other languages can be added as separate adapters later. This page describes the contract a new adapter has to meet, using the TypeScript adapter as the example.

## The 3 operations

The CLI asks an adapter 3 things. The types are on the generated [Adapter protocol](../reference/adapter-protocol) page.

| Operation | When the CLI calls it | What the adapter returns |
|---|---|---|
| `info` | before anything else | its name, version, protocol number, the file extensions it reads in `_/` and the extension of DMZ files |
| `init` | during `buckets init`, also in the enclosing project when a nested one is created | the project files it changed to support the rules, and the ones that need a hand edit |
| `analyze` | on every check, once per project | problems in the project settings, every DMZ re-export with its signature hash, every import of every code file, a report for each link, the toolchain and the files it read |

Every response, and every request except `info`, carries the protocol version in `abi`. The CLI refuses an adapter that speaks a different version, and the check exits with code 3.

### info

`extensions` says which files inside `_/` the adapter analyzes. `dmzExtension` is the extension of DMZ files, which the CLI uses to build their names, as in `dmz/log/billing.ts`.

### init

`init` must be safe to run more than once. On a project that is already set up, it returns an empty `changed` list. The TypeScript adapter adds the alias to `compilerOptions.paths` in `tsconfig.json`, turns on `noUnusedLocals`, sets `sourceRoot` and `entryFile` in `nest-cli.json` when that file exists, and adds the alias to the Jest `moduleNameMapper` when `package.json` has a Jest config.

The request can list `nestedProjects`, the folders of the projects nested in this one. A nested project builds with its own settings, so the adapter keeps each folder out of this project's build. The TypeScript adapter adds it to `exclude` in `tsconfig.json` when `include` reaches it. The CLI sends this request to the enclosing project when `buckets init` creates a nested one.

Each entry of `changed` names a file and describes the change. `written: false` marks a file the adapter left as it was, because it could not edit it safely. Its description then says what to change by hand, and the CLI shows it as a step for the human.

### analyze

The CLI builds the list of files itself, because the folder rules do not depend on the language, and sends all of them in one call. Building the compiler's view of a project is the expensive part, and one call builds it once.

The response has 3 parts:

- `config` lists problems in the project settings. Any item makes the check exit with code 1, as the rule `project-config`. The TypeScript adapter reports a missing or wrong alias in `paths`, `noUnusedLocals` turned off, a build that does not cover the root bucket folder, and a build that still reaches one of the `nestedProjects` of the request.
- `dmz` lists, for each DMZ file, every re-export and every syntax violation. Each re-export has the symbol `name`, whether it is `typeOnly`, the resolved file it comes `from`, the `line` and a `signature` hash. Because renames are not allowed, a symbol keeps its name along the whole chain, and the CLI follows the chain by matching `from` and `name`. DMZ syntax depends on the language, so the adapter reports those violations and the CLI turns them into `dmz-syntax`.
- `code` lists, for each code file, every import, including `export ... from` inside `_/`, and any way the file shares code without an import (`globals`). Each entry of `globals` has a line and a message that says how to fix that case, and the CLI reports it as `import-global`.

More fields help the CLI:

- `links` describes each link of the request. See [Links](#links).
- `toolchain` names the tools whose version can change signature hashes, such as `typescript@5.9.3`. See [Signature hashes](#signature-hashes).
- `inputs` lists every file the analysis read: the tsconfig chain, `package.json` files and every source file of the program, including `.d.ts` files outside the root folder, type packages and linked files, plus the `.external.ts` and `node_modules` paths it probed for links, which may not exist. The CLI keys its analysis cache in `.buckets/cache/` on these files. It never caches an answer without `inputs`.

Each import has a `kind`:

| kind | Meaning | target |
|---|---|---|
| `internal` | import through the alias | the resolved file |
| `relative` | import with a relative path | the text of the import |
| `package` | external package | the package name |
| `builtin` | Node built-in module | the module name |
| `dynamic` | `import()` or `require()` | the text of the import, or `null` when it is not a fixed string |
| `unresolved` | the adapter could not classify it | the text of the import |

For `internal`, `names` lists the imported symbols. An `import * as x` comes back as `names: ["*"]`, and a side-effect import as `names: []`. For `package`, `declared` says whether the package is in `package.json`. More fields on an import:

- `unusedNames` lists imported names the file never references. They do not count as a use of a DMZ symbol.
- `reexport` is true for `export ... from` inside code. A re-export alone is not a use.
- `reexportedAs` pairs an imported name with the name the file exports it as, for barrels such as `export { a as b } from` or `import { a }` followed by `export { a as b }`. The CLI follows these inside a bucket, so a contract re-exported by an index in `_/` and used by another file of the same bucket counts as used.
- `typeOnly` is true only when the whole statement is type-only: `import type`, `export type ... from`, a type `import('x')` or a JSDoc `@import`. `import { type A }` is not, because `verbatimModuleSyntax` keeps it as a runtime import.

The adapter only classifies. The CLI decides what is forbidden, follows the re-export chains, finds cycles and orphans and compares the result with the lock.

## Links

When the project has links, the analyze request lists them in `links`: the link folder, `<bucket>/_/links/<name>`, and the alias of the origin project. The folder is a junction or symlink to the root bucket folder of the origin, or a plain copy of its source files. The adapter maps `<alias>/*` to `<folder>/*` for this analysis, and does not analyze the files inside a link as code of this project, even when they are listed in `files.code`. Imports of a link from this project are `internal` entries whose `target` goes through the link folder.

The response has one report per link in `links`, keyed by the link folder. Every path in it is relative to the project and goes through the link:

- `exports` lists every symbol that a `.external.ts` file inside the link publishes, with the same signature hash as a DMZ symbol. The hash must be the same for a junction and a copy of the same origin, wherever the link lives, because the lock of the consumer pins it.
- `dependencies` lists every package that a linked file reachable from the `.external.ts` files imports, Node built-ins left out. `resolvedForTypes` says whether a lookup from the link path finds the package or its `@types` package, as the type checker of the consumer needs. `resolvedAtRuntime` says whether a lookup from the real path finds it, as Node and bundlers need, and is also true when every import of the package in that file is type-only. `resolved` is true when both are. The CLI reports each unresolved package as `link-missing-dependency`.
- `problems` lists what kept the adapter from reading the link, such as a missing folder, no `.external.ts` file, a parse error or a broken re-export. The CLI reports them as `project-config`.

An adapter that leaves out `resolvedForTypes` and `resolvedAtRuntime` still works. The CLI then has only `resolved`, and its message names both places to install the package.

The adapter writes nothing to disk. The CLI creates and removes the link folders, and compares the published signatures with the lock.

## Conventions

- Every path, in requests and responses, is relative to the project folder and uses `/`, also on Windows.
- Lines count from 1.
- A broken rule is not an adapter failure. It comes back as data in the response.
- An environment problem, such as a missing compiler, is reported with an environment code, and the check exits with code 3. The TypeScript adapter uses `no-typescript`, `no-tsconfig` and `adapter-failed`.

## Signature hashes

The lock stores a hash of each re-exported symbol's type signature, so a signature change in `_/` shows up even when no DMZ file changed. The hash must be the same on every machine. The TypeScript adapter hashes a structural description of the symbol, obtained from the type checker: properties with their names, optionality and types for interfaces, classes and object types, expanding named types declared in the project up to a depth of 3 (types from lib files and `node_modules` stay as their names), and every call signature for functions. The description never contains absolute paths.

Because a different compiler version can change these hashes, the adapter reports the tools that affect them in `toolchain`, such as `typescript@5.9.3`, and the CLI stores it in the lock.

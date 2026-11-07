---
title: Writing an adapter
description: How the CLI splits the work with a language adapter, and what an adapter must answer in protocol 2.
---

# Writing an adapter

The CLI applies every rule. A language adapter reads source files and reports their imports and, for public files, their exports, as data. The adapter applies no rule and decides nothing.

The TypeScript adapter, `adapters/ts/` in the repository, ships inside the CLI and reads `.ts .tsx .mts .cts .js .jsx .mjs .cjs`. It is the only adapter today, and the CLI calls it inside its own process. This page describes the contract a new adapter meets. The types are on the generated [Adapter protocol](../reference/adapter-protocol) page.

An adapter never changes project files. It only reads them.

## The 2 operations

| Operation | When the CLI calls it | What the adapter returns |
|---|---|---|
| `info` | for `buckets --version` and before each request, to check the protocol version | its name, version, protocol version and the file extensions it reads |
| `analyze` | when the cache misses a file, and for the edit a hook simulates | the imports of each file, the exports of each public file, and the files that affect module resolution |

Every request and response carries the protocol version, 2, in the field `abi`. The CLI reads the version from `info` before it sends a request, and when it is not 2 the check fails with `adapter-failed` and exits with code 3. The TypeScript adapter also answers a request with another version with `adapter-failed`. `buckets --version` prints the CLI version on its first line and the adapter on its second, `adapter ts 2.0.0 (protocol 2)`.

### analyze

The request lists the `files` to analyze, the `publicFiles` among them that need export details, and optional `contents`: text that replaces a file on disk, for the edit a pre-edit hook simulates. A path in `contents` may not exist on disk yet. The CLI lists every analyzed file in `publicFiles`. It keeps all the exports of the public files, and of the other files the names exported as types only, which tell it when a re-export of a private import needs `export type`.

For each file, the response lists every import in source order: `import`, `export ... from`, `import()` and `require()`. Each import has:

| Field | Meaning |
|---|---|
| `specifier` | the specifier as written, or the source text of the argument when it is not a string literal |
| `line` | the 1-based line of the statement |
| `kind` | `static` for `import` and `export ... from`, `dynamic` for `import()`, `require` for `require()` |
| `literal` | false when `import()` or `require()` gets something other than a string literal; always true for `static` |
| `reexport` | true for `export ... from` |
| `names` | the imported names, each with `typeOnly`, or `"*"` for `import * as x`, `export * from`, and `import()` or `require()` without destructuring; `[]` for a side-effect import |
| `target` | `{ file }` relative to the project, `{ package }` with the package name, `{ builtin }`, or `{ unresolved, pattern? }` |

An `import()` with a string literal counts only the names it destructures. Without destructuring, its names are `"*"`, and the CLI reports `import-namespace`.

An unresolved target says what kind of specifier failed, because the CLI treats each kind differently:

| `unresolved` | The specifier | What the CLI does |
|---|---|---|
| `relative` | starts with `./` or `../` | reports `import-unresolved` |
| `paths` | matches the `paths` pattern `pattern` of the file's nearest `tsconfig.json`, or, without `pattern`, starts with a folder under `baseUrl` that is no installed package | reports `import-unresolved` |
| `workspace` | names a workspace package of the project | reports `import-unresolved` |
| `package` | is any other bare name, such as an npm package that is not installed | counts it as that package for `packages` |
| `other` | is empty, absolute, a package.json `#` import, not a string literal, or names a file that exists but is no listed source file, such as `./App.css`, `./logo.svg?url` or a file git ignores | reports `import-dynamic` when `literal` is false, and nothing otherwise |

For a public file, the response also has `exports`:

- `names`: every exported name with its line and `typeOnly`, `default` included.
- `reexports`: each named re-export, `export { a, b as c } from './x'`, with the source and exported name of each entry.
- `stars`: each `export * from` and `export * as ns from`.
- `codeLines`: the lines that hold anything other than named re-exports, comments and blank lines.

The CLI turns `stars`, `codeLines` and re-exports from another bucket into `public-not-interface`, and `names` with the imports of other buckets into `export-unused`.

The response ends with `inputs`: the files that affect module resolution, such as each `tsconfig.json` of the `extends` chain and each `package.json`, with a content hash. The CLI drops its cached resolutions when a hash changes. See [Performance](./performance#the-cache).

When the adapter cannot analyze the project at all, it returns `error` with `no-typescript`, `no-tsconfig` or `adapter-failed` and a message. The CLI reports it as an environment error, exit code 3. The TypeScript adapter returns `no-typescript` only when neither the project's `typescript` nor the TypeScript 6 of slopbuckets loads, which means the slopbuckets install is broken.

## How the TypeScript adapter works

- A light scanner extracts the imports without loading the TypeScript compiler.
- Each file resolves with the nearest `tsconfig.json` at or above it inside the project, as the TypeScript language server does. Relative specifiers, `paths` and `baseUrl` resolve against the file list of the project, without the disk. Node built-ins and npm packages are recognized by name.
- TypeScript loads only for workspace packages and for `#` imports without a `paths` entry, so `exports` maps and workspaces apply as they do in the build. The adapter loads the project's `typescript` when it is version 5 or 6, and otherwise the TypeScript 6 that slopbuckets depends on, because TypeScript 7 has no JavaScript API.
- It never reads type information. The check needs only the files, their imports and the target of each import.

## Conventions

- Every path is relative to the project folder and uses `/`, also on Windows. A path that leaves the project starts with `../`.
- Lines count from 1.
- A broken rule is never an adapter failure. The adapter reports what it found, and the CLI decides.
- A file the adapter cannot read is left out of `files`, not reported as an error.

---
name: slopbuckets
description: How to work in a project that has a buckets.config.json. Use it for any code change there, before you add a file, an import between folders or an import of an npm package or Node module, whenever a slopbuckets hook reports pending items or blocks the end of a turn, and when you design or change the buckets in buckets.config.json, including right after `buckets init` and when you translate an Nx, eslint-plugin-boundaries, Sheriff or dependency-cruiser setup.
---

# Working in a slopbuckets project

`buckets.config.json` at the project root holds the architecture: the buckets, the job of each one, its public files, the buckets and external packages it depends on, and why. You and other agents own this file. Nobody approves changes to it. The slopbuckets hooks compare the code with the file and tell you where they disagree. Fixing the code and editing the file are both valid answers, and you decide which one is right.

Read the file before you write code. It is the only place where the rules of this project live: no folder names, naming conventions or secondary files add rules. To read one bucket instead of the whole file, run `buckets show <bucket>`. It prints the bucket, its dependencies and packages with their reasons, the buckets that depend on it and its violations.

## Reading buckets.config.json

```json
{
  "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v2.json",
  "version": "2.0",
  "ignore": ["**/*.test.ts", "scripts/**", "*.config.ts"],
  "projects": ["packages/sdk"],
  "buckets": {
    "app": {
      "purpose": "Starts the HTTP server and wires the routes",
      "files": ["src/main.ts", "src/routes/**"],
      "public": null,
      "dependsOn": {
        "billing": "Routes create and list invoices",
        "log": "Logs each request with its status"
      },
      "packages": { "express": "Serves the HTTP routes" }
    },
    "billing": {
      "purpose": "Issues and charges invoices",
      "files": ["src/billing/**"],
      "public": "src/billing/index.ts",
      "dependsOn": {
        "payments": "Charges each invoice through the gateway",
        "log": "Logs failed charges with the invoice id"
      },
      "packages": {
        "zod": "Validates the invoice payloads of the public API",
        "node:fs": "Writes invoice PDFs to the export folder"
      }
    },
    "payments": {
      "purpose": "Talks to the payment gateway",
      "files": ["src/payments/**"],
      "public": ["src/payments/index.ts", "src/payments/webhook.ts"],
      "dependsOn": {},
      "packages": { "stripe": "Calls the Stripe API for charges and refunds" }
    },
    "log": {
      "purpose": "Formats and writes application logs",
      "files": ["src/log/**"],
      "public": "src/log/index.ts",
      "dependsOn": {},
      "packages": {}
    }
  }
}
```

The top level has these fields:

- `version` is the format of the file, `"2.0"`. Keep the value `buckets init` wrote. A slopbuckets older than the config does not check it: `buckets check` exits with 3 and says to run `buckets update`, and the hooks show that message once and deny nothing because of it.
- `ignore` lists globs of files outside the architecture, such as tests and scripts. The check removes these files before it matches any bucket glob, so `ignore` wins over `files`: a file that `ignore` matches is ignored even when a bucket's `files` also match it, and it never conflicts with a bucket. A glob that starts with `!` takes files back out of `ignore`.
- `projects` lists folders of nested projects, each with its own `buckets.config.json`.
- `buckets` maps a name (lowercase letters, digits and `-`, starting with a letter) to a bucket.

Every bucket has five required fields and one optional field:

- `purpose` is one line that says what the bucket does.
- `files` is a non-empty list of globs relative to the config. A glob that starts with `!` excludes files an earlier glob matched.
- `public` names the files other buckets may import. It is one path, a list of paths, or `null` when the bucket exports nothing.
- `dependsOn` maps each bucket this one may import to a one-line reason. Write `{}` when it depends on nothing. Every dependency is its own entry with its own reason, even toward a bucket that fifty others use.
- `packages` maps every external module that the files of the bucket import, npm packages and Node built-ins, to a one-line reason. Write `{}` when it imports none. The section [Packages](#packages) says which key an import takes.
- `external` is optional: a one-line reason that says which code outside the project uses the public files, such as the entry of an npm package.

What the check reads: files with the extensions `.ts .tsx .mts .cts .js .jsx .mjs .cjs` that git sees (tracked, or untracked and not gitignored). Outside a git repository it walks the folders and skips `node_modules` and folders that start with a dot. Each file resolves its imports with the nearest `tsconfig.json` at or above it inside the project, as the TypeScript language server does.

Every file the check reads must be in exactly one bucket or in `ignore`. With the config above, `src/billing/invoice.ts` may import `src/payments/index.ts`, `src/payments/webhook.ts` and `src/log/index.ts`, and nothing else from other buckets. It may import `zod`, `node:fs` and `fs/promises`, and no other package. `src/payments/client.ts` may not import anything from `billing`, because `payments.dependsOn` is empty.

## The rules

| Rule | What it reports |
|---|---|
| `config-invalid` | the config is not valid JSON, misses a required field, has an empty reason, names a bucket that does not exist, or has a `packages` key that is not a package name |
| `config-cycle` | the `dependsOn` graph has a cycle |
| `dependency-undeclared` | a file of A imports B, and `A.dependsOn` does not list B |
| `dependency-unused` | `A.dependsOn` lists B, and no file of A imports B |
| `import-private` | a file of A imports a file of B that `B.public` does not list, or any file of B when `B.public` is `null`, and A declares B |
| `import-unresolved` | a relative import, an import that matches a tsconfig `paths` pattern, or an import of a workspace package does not resolve to a file |
| `import-ignored` | a bucket file imports an ignored file |
| `import-dynamic` | `import()` or `require()` with an argument that is not a string literal |
| `import-namespace` | `import * as x`, `export * from`, or `import()` or `require()` without destructuring, pointing at another bucket |
| `file-unowned` | a file is in no bucket and not ignored |
| `file-overlap` | a file is in two or more buckets |
| `glob-empty` | a glob of `files` or `ignore`, or a folder of `projects`, matches nothing |
| `public-missing` | a file that `public` lists does not exist or is not a file of the bucket |
| `public-not-interface` | a public file has code, uses `export *` or re-exports from another bucket |
| `project-undeclared` | a nested `buckets.config.json` is not listed in `projects` |
| `export-unused` | a name exported by a public file is not imported by any other bucket |
| `package-undeclared` | a bucket file imports an npm package or a Node built-in that the bucket's `packages` does not list |
| `package-unused` | the bucket's `packages` lists a package that no file of the bucket imports |

When A imports a private file of B and A does not declare B, the check reports one `dependency-undeclared` that marks the private imports, not an `import-private` too. Its fix lists both steps.

Code can only follow declared dependencies, so a cycle in the code always shows up as a cycle in the config. `import()` and `require()` with a string literal count as normal imports. An `import()` counts only the names it destructures, also in the `import('x').then(({ a }) => ...)` form that `React.lazy` and `next/dynamic` use.

While an import of a bucket does not resolve, the check holds back the `dependency-unused` of that bucket and the `export-unused` that the missing import could explain, so it never tells you to delete a reason that a broken path hides. Fix `import-unresolved` first. It often means the dependencies are not installed or a `paths` alias is stale after a move.

### Advice

Advice is a note on the quality of the config. It never fails the check and never blocks a turn. `buckets check` prints it after the violations, and the stop hook adds it when it blocks for a violation anyway. When an edit of the config writes a purpose or reason with `reason-generic` advice, the next tool call shows that advice once, after the pending list, and does not block. Rewrite that purpose or reason so that it says what the code does. When a turn ends with no violation but wrote such a purpose or reason, the stop hook also shows that advice once to the user and lets the turn end.

| Advice | What it reports |
|---|---|
| `reason-generic` | a purpose or reason (of `dependsOn`, `packages` or `external`) has fewer than three words, or is only a bucket name and a generic verb such as uses, needs, calls, imports or depends on |
| `ignore-large` | an `ignore` glob matches more than 20% of the source files, not counting tests, scripts, fixtures and examples, which then fall outside every rule |

## How the hooks behave

The hooks stay silent while the code matches the config. They cost no tokens then.

When something disagrees, the hook adds a pending list to your context before each tool call, of any tool, until the list is empty. Before an edit, the list includes the effect of that edit, simulated in memory. The list starts with a header and has up to three sections:

```
buckets: 3 pending. Fix the code or edit buckets.config.json. Either is valid. Full detail: buckets check

[NEW]
billing -> payments: private file
  src/billing/invoice.ts:3 imports src/payments/client.ts
  payments public: src/payments/index.ts
  fix code: import from src/payments/index.ts instead, and add the re-exports it lacks: export { name } from './client'

[OLD]
billing -> log: undeclared dependency (src/billing/invoice.ts:3)
src/utils/date.ts: in no bucket

[RESOLVED]
src/billing/stripe/charge.ts: in two buckets
```

- `[NEW]` shows a pending item in full, once. Each full item ends with what to do: `fix code:`, then `fix config:` when both paths make sense, with the exact names, files and keys. When both are there, a `choose one fix:` line comes above them. The two fix lines are alternatives, and you pick one. You can act without opening anything.
- `[OLD]` repeats items you already saw as one-line reminders, without the fixes. Run `buckets check` to see them in full again.
- `[RESOLVED]` lists items that went away since the last call, once.

You may leave items pending while you work through a multi-step change. At the end of the turn, if the session changed files, the stop hook runs the full check. With items left, it blocks the stop once and lists all of them in full, under a header such as `buckets: 3 structure violations remain.` Fix them or change the config, then finish. Subagents get the same block when they stop. When the same items were also left at the end of an earlier turn, the block says so. If you still leave them, tell the user which ones and why.

An edit that makes `buckets.config.json` worse, with a config problem that was not there or more of them, is denied and never reaches the disk. The message names the field and the fix. To rename a bucket, rename its key and every `dependsOn` entry that names it in the same edit. A config that is already invalid, for example after a merge, shows in the pending list, and edits that fix it one problem at a time go through. Every other rule only warns before a tool call.

In a repository with several projects, the hook finds the project of each edited file from its path: the nearest `buckets.config.json` at or above the file. An edit in `packages/sdk/` is checked against `packages/sdk/buckets.config.json`, whichever folder the session was opened in.

Both fixes are valid. The hook never prefers one. Choose the code fix when the code broke a design that still makes sense. Choose the config fix when the design was wrong, outdated or missing a decision. Do not pick the config fix only because it is fewer keystrokes: a config edit changes the rules for every later agent.

Some agents cannot add context before a tool call. They get the warning after the edit instead. Run `buckets check` before you finish when you do not know whether your agent has a slopbuckets stop hook. A git pre-commit hook may run it too.

## Where a new file lives

1. Read the purposes. Pick the bucket whose job covers what the file does.
2. Put the file in a folder that the bucket's `files` globs match. Check that no other bucket's globs match it too.
3. If the code is needed by other buckets, re-export its names from a public file of its bucket, and add the dependency with a reason to each bucket that imports it.
4. If the file imports an npm package or a Node module, add it to the bucket's `packages` with a reason, unless it is there already.
5. If no purpose covers the job, decide between widening the purpose of the closest bucket and creating a bucket. See the next section.
6. Tests, scripts and tool configs go under globs in `ignore`, not in a bucket. Generated files that bucket code imports go in a bucket. See [Framework conventions and generated code](#framework-conventions-and-generated-code).

Never create a file in a folder no bucket owns and leave it unowned. Never drop a file into a bucket whose purpose does not mention its job just to make the check pass.

## When to create a bucket

Create a bucket when a group of files has one job you can state in one line, other code uses that job through a small set of names, and the files can change without the users noticing. A domain such as billing, search or auth is the usual unit. An adapter to an outside system, such as a payment gateway or a database client, is another.

Do not create a bucket for:
- one helper function or one type. Put it in the bucket that uses it, or in the bucket whose job it belongs to.
- each folder. Folders inside a bucket organize code freely and add no rules.
- a technical layer (`controllers`, `services`, `models`) when the code is organized by domain.
- code that only one bucket uses and that has no job of its own.

## When to declare a dependency and when to move the code

When a file of A needs something from B, ask whether A's job uses B's job. If you can write a reason that says what A does with B, such as "Charges each invoice through the gateway", declare it: add `"b": "<reason>"` to `A.dependsOn` and import from a public file of B.

Move the code instead when:
- the thing you need belongs to A's job and sits in B by accident. Move it into A.
- only A uses it. Move it into A and drop it from B's public file.
- the dependency would create a cycle. Move the code that needs the reverse direction so one direction disappears, or merge the two buckets if they are one job. When B already reaches A through `dependsOn`, the message says `no config fix:` and names the cycle the entry would create.
- the reason you would write is "uses one helper" or repeats the bucket name. That is a sign the helper is in the wrong bucket.

Remove a dependency as soon as the last import from it goes away. `dependency-unused` reports it, with the old reason, so you can check whether the reason still holds.

## Packages

Every external import of a bucket file needs an entry in that bucket's `packages`, with a reason, like a bucket in `dependsOn`. External means an npm package or a Node built-in.

- The key is the package name without a subpath. `lodash/merge` is the key `lodash`, and `@scope/pkg/server` is `@scope/pkg`.
- Node built-ins use the `node:` prefix. `fs`, `node:fs` and `fs/promises` all count as `node:fs`. A key such as `fs` or `lodash/merge` is `config-invalid`, and its message names the right key.
- Type-only imports count. `import type { Request } from 'express'` needs `express`.
- An npm package that is not installed still counts under its name.
- Ignored files need no entry.
- A workspace package that lives in another project, such as a sibling package with its own config, is a package of this project and goes in `packages` too.

The reason says what the bucket uses the package for: `"stripe": "Calls the Stripe API for charges and refunds"`, not `"stripe": "Uses stripe"`. When a second bucket starts to import a package, ask whether the code belongs in the bucket that already declares it. The `package-undeclared` message lists up to three buckets that declare the package, with their reasons, so you can tell. A package such as `jsonwebtoken` that two buckets both use is often one job split in two.

## Purposes and reasons

Purposes and reasons are how earlier agents' decisions reach later ones. The next agent reads them to decide where code goes and whether a new import fits the design. The check shows them in its messages: `dependency-undeclared` prints the purpose of both buckets and up to three buckets that already declare the target, with their reasons, and `dependency-unused` prints the reason.

A purpose names the job and the boundary, in one line:
- Good: `Issues and charges invoices`, `Talks to the payment gateway`, `Parses and validates buckets.config.json`.
- Bad: `Billing stuff`, `The billing bucket`, `Helpers`, `Business logic`.

A reason says what the dependent bucket does with the other one:
- Good: `"payments": "Charges each invoice through the gateway"`, `"log": "Logs failed charges with the invoice id"`.
- Bad: `"payments": "Depends on payments"`, `"log": "Uses log"`, `"payments": "Needed for import"`.

Write a reason that would let the next agent tell whether a new import from the same bucket belongs. When the dependency grows to cover a new use, update the reason. The `reason-generic` advice flags purposes and reasons under three words and reasons that only name a bucket with a generic verb. It also flags a purpose made only of bucket names and filler words such as does, job, stuff, things and handles, like "Does the billing job".

### Accepted debt

Sometimes a dependency is wrong and you keep it for now, because the fix is out of the scope of your task. Declare it, and start its reason with `debt:`, then say what is wrong and how it goes away:

```json
"dependsOn": {
  "orders": "debt: reads the order table to count retries; move the counter into billing"
}
```

The check treats it as any other reason, and the next agent finds every accepted debt with a search for `"debt:`. Use it for a dependency you decided to keep. Do not use it to silence a dependency you did not think about.

## The public file

The public files of a bucket are the only files other buckets may import. Together they are the bucket's interface and hold nothing else.

```ts
// src/payments/index.ts
export { charge, refund } from './client';
export type { Charge, Refund } from './types';
export { createGateway as default } from './gateway';
```

- A public file holds only named re-exports: `export { a } from './x'`, `export type { T } from './y'` and renames with `as`, including to `default`. Any declaration, statement or `export *` is `public-not-interface`.
- Re-export types with `export type { T }`. With `isolatedModules`, which Next.js turns on, `export { T }` of a type is a TypeScript error, and the fix lines of the check write `export type` for names that every import takes as types only.
- It re-exports only from its own bucket. A bucket that needs another bucket's names imports them from that bucket's public file and declares the dependency. The one exception is a bucket with `external`, see below.
- Keep the interface small. Export what other buckets import today, not what they might import later.
- Every export must have a consumer in another bucket. Imports from tests or ignored files do not count, so a test cannot keep a dead export alive. `import type` counts as a use.
- Name what you import. `import * as x from '../payments'` hides which names are used and is reported.

`public` takes three forms:

- One path, `"public": "src/billing/index.ts"`, for most buckets.
- A list, `"public": ["src/user/index.ts", "src/user/server.ts"]`, when the bucket has separate entries: a server and a client entry in Next.js, the subpath exports of a package, or one entry per NestJS module surface that a single barrel would tangle into cycles. Each file in the list follows the same rules. Do not list every file of the bucket: a file with code cannot be public.
- `null`, for a bucket that nothing imports, such as an app entry point, CLI commands or the route files of a framework. Any import of a closed bucket is reported.

`"external": "<reason>"` says that code outside this project uses the public files, such as the entry of an npm package or the exports a framework loads by name. It exempts the bucket from `export-unused`. A bucket with `external` may also re-export by name from the buckets in its own `dependsOn`, so a library entry can gather the names of several buckets in one file. Do not add `external` to keep an unused export alive.

## When to split a bucket

Split a bucket when:
- its purpose needs "and" to join two unrelated jobs.
- its dependents use disjoint parts of its public files. The bucket panel of `buckets inspect` shows "May want to split" when its dependents fall into two or more groups that share no exported name.
- part of it has dependencies or packages the rest does not need.
- its public files keep growing with names that only one dependent uses.

To split, add the new bucket with its own `files`, exclude those files from the old bucket with a `!` glob or move them to a new folder, give the new bucket its public file, move the matching `dependsOn` and `packages` entries, and update the imports and `dependsOn` of every bucket that used the moved names. Run `buckets check` and work through the list.

## The first architecture after buckets init

`buckets init` writes a config with `"buckets": {}`, so every file starts unowned. `buckets check` then reports one item that lists the folders with their file counts:

```
buckets.config.json: no buckets yet, 197 files are in no bucket
  scripts/** (4 files)
  src/app/** (40 files)
  src/components/** (120 files)
  src/lib/** (31 files)
  next.config.ts
  src/middleware.ts
```

1. Read the code enough to know what each folder does. Do not put `src/**` in one bucket or in `ignore`.
2. Add globs for tests, scripts, tool configs and fixtures to `ignore`. Generated files that bucket code imports stay out of `ignore`.
3. Group the rest by domain. One bucket per domain folder is the usual start. Give the app entry point and the framework's route files their own bucket with `"public": null`.
4. For each bucket, write `purpose`, `files`, `public`, `"dependsOn": {}` and `"packages": {}`. Point `public` at the existing `index.ts` if the folder has one, or create a file with named re-exports.
5. Run `buckets check`. On a large project, `buckets check --summary` first prints the counts per rule and per bucket. `dependency-undeclared` lists the imports that cross buckets today. For each one, declare the dependency with a real reason, or move the code. `package-undeclared` lists the packages each bucket imports: declare each with a reason.
6. Fix the private imports with `buckets fix import-private`. It adds the missing re-exports to the public file of each imported bucket and points the imports at it, keeping their alias or relative style. `--dry-run` prints the plan first. It never edits `dependsOn`, so the undeclared dependencies stay reported for you to decide. It skips imports of a bucket with `"public": null`.
7. Fix `public-not-interface` by moving code out of the public file. Remove the names `export-unused` reports.
8. Repeat until `buckets check` exits 0.

Expect several rounds. A first pass that declares every import as a dependency is a starting point. Look for dependencies whose reasons you could not write well, and move that code.

## Translating another boundary tool

A project may already describe its boundaries in another tool. Translate it into buckets, then run `buckets check` and declare what the code really does. Every tool below writes rules that cover many edges at once, by tag, type or path pattern. slopbuckets has no such rule: each edge the code uses is one `dependsOn` entry with its own reason, and an edge the old rules allowed but no code uses is not declared.

- Nx: each project (a folder with `project.json`) becomes a bucket, with the project folder as `files` and its entry file, usually `src/index.ts` behind the tsconfig path alias, as `public`. The tags and `depConstraints` of `@nx/enforce-module-boundaries` become the `dependsOn` entries that the imports need, each with a reason. An app project becomes a bucket with `"public": null`.
- eslint-plugin-boundaries: each element of `boundaries/elements` becomes a bucket per folder it matches. A `features/*` pattern with a capture becomes one bucket per feature, and the `pattern` becomes `files`. The files that `boundaries/entry-point` allows become `public`. The `allow` lists of `boundaries/element-types` become `dependsOn` entries for the edges that exist.
- Sheriff: each module of `sheriff.config.ts` becomes a bucket, and its barrel `index.ts` becomes `public`. A module pattern with a placeholder such as `<domain>` becomes one bucket per folder. The tag rules of `depRules` become `dependsOn` entries for the edges that exist.
- dependency-cruiser: the folders that the `from` and `to` paths of the rules name become buckets. A `forbidden` rule between two folders is the absence of a `dependsOn` entry, and an `allowed` rule becomes the entries the imports need. `no-circular` is `config-cycle`, and `not-to-unresolvable` is `import-unresolved`.

Keep the old tool until the config passes, then remove its rules, so the project has one place for its architecture.

## Framework conventions and generated code

Some files are loaded by a framework and never imported. Some are written by a generator. Both need a bucket.

- Routes and pages that a framework finds by convention, such as Next.js `app/` and `pages/`, `middleware.ts`, Remix routes or SvelteKit routes, go in a bucket with `"public": null`. Nothing imports them, and their exports, such as `default`, `metadata` or `GET`, are read by the framework. The route bucket declares the domain buckets it calls in `dependsOn`. A large app may split its routes into one bucket per area.
- A NestJS app gets one bucket per module folder, with `main.ts` and the root module in a bucket with `"public": null`.
- ORM entities of tables that reference each other go in the same bucket. A relation such as `@ManyToOne(() => User)` imports in both directions, and two buckets that import each other's entities form a cycle. The bucket that owns the tables is the only one that queries them, and other buckets go through its public files.
- A generated file that bucket code imports goes in a bucket, never in `ignore`, because a bucket file that imports an ignored file is reported. Put it in the bucket whose job the generator serves, such as an API client generated from an OpenAPI spec in the bucket that talks to that API, and re-export from a hand-written public file what other buckets need. Generated code under `node_modules`, such as `@prisma/client`, is a package and goes in `packages`.
- Tool configs at the root, such as `next.config.ts`, `vite.config.ts` or `eslint.config.js`, go in `ignore`.

## ignore

Use `ignore` for files that are not part of the product code: tests, test fixtures, scripts, and build and tool configs. Ignored files may import private files of any bucket, so tests can reach internals. They need no `packages` entries.

Do not use `ignore` to silence a rule. A product file in `ignore` drops out of every check, and the next agent loses the information. If bucket code imports an ignored file, `import-ignored` reports it: move that file into a bucket. An `ignore` glob that covers more than 20% of the source files, not counting tests, scripts, fixtures and examples, gets `ignore-large` advice.

## Monorepos and nested projects

Give each package or app of a monorepo, a folder with its own `package.json`, its own `buckets.config.json`, and list its folder in `projects` of the config at the root. A folder listed in `projects` holds its own buckets and rules. Its files leave the enclosing project: no bucket there may list them, and the enclosing project's rules do not apply to them. `buckets check` checks the current project and every nested one, and `buckets check --no-recursive` checks only the current one.

- Each project resolves imports with its own `tsconfig.json`, so a nested project with code needs one in its folder.
- An import of another package of the monorepo is an external import for the importing project: declare the package in `packages` of the importing bucket. Inside one project, an import of a workspace package that does not resolve, for example before the install, is `import-unresolved`.
- The root config of a monorepo whose code all lives in packages has `"buckets": {}` and puts its own scripts and tool configs in `ignore`. When every file of the root itself is ignored, the root needs no `tsconfig.json`.
- A package that publishes its entry to npm marks that bucket with `external`.

To add a nested project, create `buckets.config.json` in its folder with `{"version": "2.0", "buckets": {}}`, and add the folder to `projects` of the enclosing config. A nested `buckets.config.json` that `projects` does not list is `project-undeclared`. The hooks installed at the root already cover the nested project, because they find the config from the path of each edited file.

## What to avoid

- A `utils`, `shared` or `common` bucket that every bucket depends on. It collects unrelated code with no job, and its reasons all read "uses a helper". Put each helper in the bucket whose job it serves. Keep a bucket that many depend on only when it has a real job, such as `log`, and give each dependent its own reason.
- A dependency created only to make one import pass. If the reason is weak, move the code.
- Making everything public, or re-exporting a whole bucket in its public file. Export the names other buckets use.
- `ignore` as an escape hatch for product code that breaks a rule.
- Buckets per technical layer (`controllers`, `services`, `repositories`) when the project is organized by domain.
- Reasons and purposes that repeat the bucket name, such as `"log": "Uses log"`.
- One giant bucket, such as a single bucket with `src/**`. Every rule then passes and the check says nothing about the architecture.
- Coupling that does not pass through imports: the same database table, event topic, environment variable, cache key or dependency injection token used by two buckets. The check cannot see it. Give each table, topic or key one owning bucket, and let other buckets go through that bucket's public file.

## Commands

| Command | What it does |
|---|---|
| `buckets check` | runs every rule and prints all violations in full, as the stop hook does, then the advice |
| `buckets check --summary` | prints only the number of violations per rule and per bucket, for a first look at a large project |
| `buckets check --json` | the same result as JSON: the exit code, one object per violation with its `rule`, `project` and the files, lines and buckets of the message, the environment errors and the advice |
| `buckets check --no-recursive` | checks only the current project, not the nested ones |
| `buckets show <bucket>` | prints one bucket: purpose, files, public files, dependencies and packages with their reasons, dependents and violations; `<project>:<bucket>` names a bucket of a nested project, and `--json` prints JSON |
| `buckets fix import-private` | adds the re-exports that private imports need to the public file of the imported bucket and points the imports at it; `--bucket <name>` fixes only the imports into that bucket, `--public <file>` with it picks the public file and adds it to `public` when it is new, `--dry-run` prints the plan |
| `buckets fmt` | rewrites `buckets.config.json` with its keys and buckets in a fixed order, so parallel edits merge cleanly; `--check` only reports |
| `buckets inspect --json` | prints the whole architecture: per project, the buckets with purpose, glob counts, public exports and their consumers, dependencies with import counts, packages, dependents, the edges between buckets (`used`, `unused`, `undeclared`), the violations and the advice |
| `buckets inspect` | serves the same data as a read-only page on `127.0.0.1` for the user |
| `buckets doctor` | checks the install: PATH, versions, `tsconfig.json`, TypeScript, unresolved imports, skill copies and the commands the hooks run |

Use `buckets inspect --json` or `buckets show` to see who imports a public export before you remove it, which buckets depend on a bucket before you split it, and the whole graph before you redesign.

Exit codes of `buckets check`:

| Code | Meaning | What you do |
|---|---|---|
| 0 | the code matches the config | finish |
| 1 | violations remain | fix the code or the config, then run it again |
| 3 | environment problem: the check could not run, for example with no `tsconfig.json`, or a config `version` newer than the CLI | read the message; fix it if it is part of your task, otherwise show it to the human |
| 64 | the command line is wrong, such as an unknown option | fix the command; every command prints its usage |

Advice never changes the exit code.

If you are a subagent and the check fails because of something outside your task, say so in your final message, with the violations. The orchestrator decides what to do.

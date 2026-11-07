---
title: Concepts
description: Buckets by glob, purpose, public files, dependsOn and packages with reasons, external, ignore, version, nested projects, the 18 rules and the advice.
---

# Concepts

slopbuckets 2.0 keeps the architecture of the project in one file, `buckets.config.json`, at the project root, and AI agents keep that file up to date. Nothing else holds a rule: no folder convention, no naming scheme, no second file. An agent that reads the config knows every bucket, what it is for, what it may import and why.

Two principles shape the format:

- Everything is explicit. No default hides a rule. A bucket lists its public files, or declares `null`. A file outside every bucket must be listed in `ignore`. Two globs that match the same file are a conflict. Every dependency on another bucket and every external package has its own entry with a reason.
- Agents change the code and the config on their own. When the two diverge, the hooks say so, and both answers are valid. The git history of the config is the history of the architecture.

## The config

```json
{
  "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v2.json",
  "version": "2.0",
  "ignore": ["**/*.test.ts", "scripts/**"],
  "projects": ["packages/sdk"],
  "buckets": {
    "billing": {
      "purpose": "Issues and charges invoices",
      "files": ["src/billing/**", "!src/billing/stripe/**"],
      "public": "src/billing/index.ts",
      "dependsOn": {
        "payments": "Charges each invoice through the gateway",
        "log": "Logs failed charges with the invoice id"
      },
      "packages": {
        "zod": "Validates the invoice payloads of the public API"
      }
    },
    "payments": {
      "purpose": "Talks to the payment gateway",
      "files": ["src/payments/**"],
      "public": ["src/payments/index.ts", "src/payments/webhook.ts"],
      "dependsOn": {},
      "packages": {
        "stripe": "Calls the Stripe API for charges and refunds"
      }
    }
  }
}
```

Every path and glob is relative to the folder of the config and uses `/`. The [config reference](../reference/config) lists every field with its constraints.

## version

The format of the file, `"2.0"`. `buckets init` writes it, and you keep it as it is. A slopbuckets that is older than the config, such as 2.0 reading a `"2.1"` config, does not check that project. It reports the environment error `config-newer`, which says which version the config needs and to run `buckets update`, and `buckets check` exits with 3. The hooks show that message once per session and never deny an edit or block a stop because of it, so a team with mixed installs keeps working.

## Buckets

A bucket is a set of files with one job. The key is its name: lowercase letters, digits and `-`, starting with a letter, such as `billing` or `payment-gateway`. Every bucket has five required fields, `purpose`, `files`, `public`, `dependsOn` and `packages`, and one optional field, `external`.

### purpose

One line that says what the bucket does. Write it for the next agent, the one that decides where new code goes: "Issues and charges invoices", not "The billing bucket".

### files

Globs of the files that belong to the bucket. A glob that starts with `!` excludes files that an earlier glob matched, as in `["src/billing/**", "!src/billing/stripe/**"]`. A file belongs to exactly one bucket. A file in two buckets is `file-overlap`, and a glob that matches no file is `glob-empty`. While no glob of a bucket matches a file, as after a folder move, the check holds back the `dependency-unused`, `package-unused` and `export-unused` of that bucket, and while the project also has unowned files, the `export-unused` of every bucket. Those would tell the agent to delete correct entries.

Buckets follow files, not folders. A bucket can own one folder, part of a folder or files spread across several folders, so the config describes the project as it is instead of asking you to move files first.

### public

The files other buckets may import. `public` takes one of three forms:

- one path, `"src/billing/index.ts"`, which fits most buckets;
- a list of paths, `["src/payments/index.ts", "src/payments/webhook.ts"]`, for a bucket with separate entries, such as the server and client entries of a Next.js app or the subpath exports of a package;
- `null`, which declares that the bucket exports nothing, such as an app entry point or the routes of a framework.

A public file holds only named re-exports of files of its own bucket:

```ts
export { charge, refund } from './client';
export type { Invoice } from './types';
export { createInvoice as default } from './create';
```

Anything else in a public file, such as a function, a constant or `export *`, is `public-not-interface`, and so is a re-export from another bucket. So the public files are the interface of the bucket and nothing else. Listing every file of a bucket does not get around this, because a file with code cannot be public. An import of any file of the bucket that `public` does not list is `import-private`. When the bucket is `null`, the message says "payments is closed".

### dependsOn

The buckets this bucket may import, each with a one-line reason. `{}` when it depends on nothing. A log bucket used by 50 buckets needs 50 entries, and each says why that bucket needs logging.

- An import of a bucket that is not listed is `dependency-undeclared`. Its message shows the purpose of both buckets, because it asks for an architecture decision, and up to three buckets that already declare the target, with their reasons.
- A listed bucket that no file imports is `dependency-unused`, so a stale reason never stays in the file.
- A cycle in `dependsOn` is `config-cycle`. The code can only follow declared dependencies, so a cycle in the code needs a cycle in the config first, and the check looks only at the config for cycles. When declaring a missing dependency would close a cycle, the message of `dependency-undeclared` says so and offers only the code fix.

To rename a bucket, rename its key and every `dependsOn` entry that names it in the same edit.

### packages

Every external module that the files of the bucket import, npm packages and Node built-ins, each with a one-line reason. `{}` when it imports none. An import of a package that is not listed is `package-undeclared`, and a listed package that no file of the bucket imports is `package-unused`.

- The key is the package name without a subpath: an import of `lodash/merge` is the key `lodash`, and `@scope/pkg/server` is `@scope/pkg`.
- A Node built-in takes the `node:` prefix: `fs`, `node:fs` and `fs/promises` are all `node:fs`.
- Type-only imports count, so `import type { Request } from 'express'` needs `express`.
- An npm package that is not installed still counts under its name.
- Ignored files need no entry.

A key in another form, such as `fs` or `lodash/merge`, is `config-invalid`, and its message names the right key.

### external

Optional. One line that says which code outside the project uses the public files, such as the entry of an npm package. With it, the bucket is exempt from `export-unused`, because its users are not in the project. A bucket with `external` may also re-export by name from the buckets in its own `dependsOn`, so the entry of a library can gather names from several buckets in one file.

## ignore

Globs of files outside the architecture, such as tests, scripts and tool configs. The check applies `ignore` before it matches any bucket glob, so `ignore` wins: an ignored file leaves the architecture and never conflicts with a bucket, even when a bucket's `files` also match it. A glob that starts with `!` takes files back out of `ignore`.

An ignored file may import any file and needs no `packages` entry. A file of a bucket that imports an ignored file is `import-ignored`, because that dependency would not show in the config. `ignore` is not an escape hatch: code that belongs to a bucket goes in that bucket, generated code that a bucket imports included.

## Which files count

The check reads the files with the extensions of the adapter (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) that git sees, as `git ls-files -co --exclude-standard` lists them, so `.gitignore` applies and `node_modules` and build output stay out. Outside a git repository, it walks the folders and skips `node_modules` and folders that start with a dot.

## Which imports count

- `import`, `export ... from`, `import()` and `require()` with a string literal count as imports. Each file resolves them with the nearest `tsconfig.json` at or above it inside the project.
- An import of another file of the project is checked against `dependsOn` and `public`.
- An import of an npm package or a Node built-in is checked against `packages`.
- A relative import, an import that matches a `paths` pattern of the tsconfig, or an import of a workspace package that does not resolve to a file is `import-unresolved`. While a bucket has one, the check holds back its `dependency-unused` and the `export-unused` that the missing import could explain, so a broken path never tells the agent to delete a correct reason.
- An import of a file that exists but has no source extension, such as `./App.css`, `./card.module.css`, `./data.json` or `./logo.svg?url`, is no code edge, and the check ignores it whichever bucket's folder holds the file. A bundler query such as `?raw` or `?url` is dropped before the lookup.
- `import()` and `require()` with anything other than a string literal are `import-dynamic`, because the check cannot see the target.
- `import * as x`, `export * from`, and `import()` or `require()` without destructuring, when they point at another bucket, are `import-namespace`. They do not say which names the code uses, and `export-unused` needs to know. An `import()` that destructures, as in `const { a } = await import('./x')` or `import('./x').then(({ a }) => a)`, counts the names it takes.

For `export-unused`, only imports from other buckets count. `import type` counts as a use, and so does a name imported through a private path. A name that only tests or ignored files import counts as unused, or one test would keep a dead export alive forever.

## Nested projects

`projects` lists folders that hold their own `buckets.config.json`. Their files leave this project, and each project is checked against its own config. A nested `buckets.config.json` that is not listed is `project-undeclared`. See [Nested projects](./nested-projects).

## The rules

| Rule | What it detects |
|---|---|
| [`config-invalid`](../reference/rules#config-invalid) | The config is not valid JSON, misses a required field, has an empty reason, names a bucket that does not exist, or has a `packages` key that is not a package name |
| [`config-cycle`](../reference/rules#config-cycle) | A cycle in the `dependsOn` graph |
| [`dependency-undeclared`](../reference/rules#dependency-undeclared) | A file of A imports B, and `A.dependsOn` does not list B |
| [`dependency-unused`](../reference/rules#dependency-unused) | `A.dependsOn` lists B, and no file of A imports B |
| [`import-private`](../reference/rules#import-private) | A file of A imports a file of B that `B.public` does not list, or any file of B when `B.public` is `null`, and A declares B |
| [`import-unresolved`](../reference/rules#import-unresolved) | A relative import, an import that matches a `paths` pattern, or an import of a workspace package does not resolve to a file |
| [`import-ignored`](../reference/rules#import-ignored) | A file of a bucket imports an ignored file |
| [`import-dynamic`](../reference/rules#import-dynamic) | `import()` or `require()` with an argument that is not a string literal |
| [`import-namespace`](../reference/rules#import-namespace) | `import * as x`, `export * from`, or `import()` or `require()` without destructuring, pointing at another bucket |
| [`file-unowned`](../reference/rules#file-unowned) | A file in no bucket and not in `ignore` |
| [`file-overlap`](../reference/rules#file-overlap) | A file in two or more buckets |
| [`glob-empty`](../reference/rules#glob-empty) | A glob of `files` or `ignore`, or a path of `projects`, that matches nothing |
| [`public-missing`](../reference/rules#public-missing) | A file that `public` lists does not exist or does not belong to the bucket |
| [`public-not-interface`](../reference/rules#public-not-interface) | A public file has code, uses `export *` or re-exports from another bucket |
| [`project-undeclared`](../reference/rules#project-undeclared) | A nested `buckets.config.json` not listed in `projects` |
| [`export-unused`](../reference/rules#export-unused) | A name in a public file of a bucket that no other bucket imports |
| [`package-undeclared`](../reference/rules#package-undeclared) | A file of a bucket imports an npm package or a Node built-in that the bucket's `packages` does not list |
| [`package-unused`](../reference/rules#package-unused) | The bucket's `packages` lists a package that no file of the bucket imports |

One problem gives one message. When A imports a private file of B and does not declare B, the check reports one `dependency-undeclared` that marks the private imports and lists both steps of the fix, not an `import-private` as well. `import-private` groups every private import between two buckets in one message.

Each rule has a full message that ends with what to do, and a one-line reminder. The [rules reference](../reference/rules) shows every message. [Hooks](./hooks) explains when the agent sees them.

## Advice

Advice is a note on the quality of the config. It never fails the check, never enters the pending list of the hooks and never blocks a turn. `buckets check` prints it after the violations, and the stop hook adds it when it blocks for a violation anyway. After an edit of the config writes a purpose or reason with `reason-generic` advice, the next tool call shows that advice once, after the pending list. A turn that ends with no violation but wrote such a purpose or reason gets that advice once more at the stop, without a block.

| Advice | What it detects |
|---|---|
| [`reason-generic`](../reference/rules#advice) | A purpose or reason (of `dependsOn`, `packages` or `external`) has fewer than three words, or is only a bucket name and a generic verb such as uses, needs, calls, imports or depends on |
| [`ignore-large`](../reference/rules#advice) | An `ignore` glob matches more than 20% of the source files, not counting tests, scripts, fixtures and examples, which then fall outside every rule |

## Two valid answers

Every violation that has two answers shows both, always in the same order: `fix code:` and then `fix config:`. The hook never prefers one. An import that breaks the config may be a mistake in the code, or a sign that the architecture should change. The agent that writes the code knows which, and when it changes the config, the reason it writes is what the next agent reads.

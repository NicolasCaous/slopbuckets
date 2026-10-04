---
title: Concepts
description: Buckets, the _/ folder, the DMZ with .self and .parent, the bucket graph and the lock.
---

# Concepts

## Why

An AI agent solves each task by the shortest path, and the shortest path is usually an import from some other part of the project. After a few hundred tasks, every module depends on every other module.

Code review does not catch this, because each import looks reasonable on its own. slopbuckets moves the boundaries out of review and into a check that fails the build. A human owns the dependency graph. The AI owns the code inside each node.

Because the contracts are fixed, the code inside a bucket is disposable. If a bucket turns into a mess, you can delete its code and have the AI rewrite it from the contracts.

## Buckets

The root of the project is a bucket. Its folder is `root` by default (the `root` field of the config). Each bucket contains only 3 kinds of things:

- `_/`, the bucket's own code, where the AI can create any files and folders
- `dmz/`, the contracts between its children, present when the bucket has children
- child buckets

```text
root/
  dmz/
  _/                main.ts, app.module.ts
  log/
    _/
  billing/
    dmz/
    _/              billing.module.ts
    invoices/
      _/
    payments/
      _/
buckets.config.json
buckets.lock.json
```

The folder rules:

1. A bucket holds only `_/`, `dmz/` and child buckets. A file directly in a bucket folder fails the check.
2. Every other folder inside a bucket is a child bucket. Inside `_/`, nothing is a bucket.
3. A `dmz/` folder in a bucket without children fails the check. A bucket with children may leave `dmz/` out, which counts as an empty DMZ.
4. The root bucket is depth 0. The tree is 2 levels deep by default (`root/billing/invoices`), and `maxDepth` in the config changes the limit.
5. Bucket names cannot start with `.`, and symbolic links or junctions are not allowed anywhere inside the root bucket folder, except the links that `buckets link add` registers in `<bucket>/_/links/<name>`.
6. The lock records the list of buckets, so a new bucket folder fails the check until a human approves it.
7. A folder inside `_/` with its own `buckets.config.json` is a separate, nested project, with its own `tsconfig.json`. The check skips it here and checks it on its own. See [Projects and links](./projects-and-links).

The name `_` cannot collide with a bucket name, and it marks in every path where the bucket tree ends and the code begins.

## Imports inside `_/`

Every internal import uses the alias from `buckets.config.json`. `buckets init` generates a unique one, such as `@root-k3x9pm2a`, and the examples in these docs write `@root` to stay short. Relative imports fail everywhere, even inside the same `_/`.

A file in `X/_/`, where `P` is the parent of `X`, may import only from:

- `X/_/`
- `P/dmz/<provider>/X`, the contracts where `X` is the consumer
- `X/dmz/<child>/.self`, the contracts the children of `X` offer to it
- packages listed in `package.json`
- Node built-in modules
- a project linked in `X/_/links/<name>`, only through the alias of that project and its `.external.ts` files, values and types alike

Also forbidden:

- dynamic loading with `import()`, `require()`, `createRequire` or `import.meta.glob`
- `import * as` from a DMZ file, because then the check cannot tell which symbols are used
- sharing code without an import: a file in `_/` must be a module, with no `declare global`, no `export as namespace` and no `/// <reference>`
- importing files of a nested project, or of the project around it

Circular imports inside a single bucket are allowed. The bucket is the AI's free area.

## The DMZ

Inside `P/dmz/`, the folder is the provider and the file is the consumer. `dmz/sql/http.ts` lists everything `http` takes from `sql`. Three names are reserved:

- `.self` is the bucket's own code in `P/_/`
- `.parent` is what `P` receives from the level above
- `.external` is what a child publishes to other projects, as in `P/dmz/<child>/.external.ts`. Another project links the source of this project and imports only these files. The consumers live outside the project, so the orphan rule skips it. See [Projects and links](./projects-and-links#publish-with-external-ts).

| File in `billing/dmz/` | Meaning |
|---|---|
| `payments/invoices.ts` | what `invoices` takes from `payments` |
| `.self/invoices.ts` | what `invoices` takes from `billing/_` |
| `invoices/.self.ts` | what `billing/_` takes from `invoices` |
| `.parent/invoices.ts` | what `invoices` takes from outside `billing` |
| `invoices/.parent.ts` | what `invoices` exposes outside `billing` |

`root/dmz/` has no `.parent`, because the root bucket has no parent. A child never receives from outside something its parent did not receive first, because `.parent/` only re-exports contracts where the parent is already the consumer.

### What a DMZ file may contain

A DMZ file can only re-export named symbols:

```ts
export { query } from '@root/sql/_/query';
export type { Row } from '@root/sql/_/types';
```

Not allowed: `export *`, default exports, renames with `as`, imports, and any declaration in the file itself (type, function or constant).

### Where each re-export may point

The surface of a bucket `X` is `X/_/**` plus its `X/dmz/*/.parent` files.

| File in `P/dmz/` | May re-export from |
|---|---|
| `<child>/<consumer>.ts` | the surface of `<child>` |
| `<child>/.self.ts` | the surface of `<child>` |
| `<child>/.parent.ts` | the surface of `<child>` |
| `.self/<consumer>.ts` | `P/_/**` |
| `.parent/<consumer>.ts` | the contracts where `P` is the consumer, in the DMZ of the parent of `P` |

### A path through two levels

Here `invoices` gets the logger from `log`:

```ts
// root/dmz/log/billing.ts
export { logger } from '@root/log/_/logger';

// root/billing/dmz/.parent/invoices.ts
export { logger } from '@root/dmz/log/billing';

// root/billing/invoices/_/create-invoice.ts
import { logger } from '@root/billing/dmz/.parent/invoices';
```

Each hop is one file. To find out what a bucket uses, open its DMZ files. A long path is harder for a human to follow, but the contracts are written for the AI, and for the AI a path is only a record of who consumes what.

## The bucket graph

The origin of a DMZ symbol is the bucket whose `_/` declares it. The check finds it by following the chain of re-exports. In the example above, the origin of `logger` is `log`, even though `invoices` imports it from a file in `billing/dmz/`.

### No cycles

Each bucket is a node. Every DMZ symbol that a `_/` imports adds an edge from the importing bucket to the symbol's origin. A cycle in this graph fails the check, and the report shows the cycle. For example, `invoices` takes the logger from `log`, and `log` takes something that `invoices` exposes upward.

### No orphans

Every DMZ symbol must be used. A symbol is in use when some `_/` file of the consumer imports it by name and references it, or when another DMZ re-exports it and that re-export is in use. Importing without using does not count, which is why the TypeScript adapter requires `noUnusedLocals`. An empty DMZ file is also an orphan.

The check finds every orphan in one run and reports the whole chain, from origin to tip, so the AI can delete it in one pass:

```text
Orphan contracts
  No _/ code imports these DMZ symbols, directly or through another DMZ.
  dmz-orphan  logger  (origin root/log)
    root/dmz/log/billing.ts               line 1
    root/billing/dmz/.parent/invoices.ts  line 1
    To fix, delete `logger` from each file above (delete a file once it is empty), or import it by name from root/billing/dmz/.parent/invoices.ts in the consumer's _/ code.
```

## The lock

`buckets.lock.json` records the last state a human approved:

- the CLI version, and the adapter name, version and toolchain (such as `typescript@5.9.3`) that wrote it
- the bucket tree
- a hash of the config with the defaults filled in, so a change in formatting alone does not count
- for every DMZ file, `.external.ts` files included, a hash of its text and a hash of the type signature of each symbol it re-exports. Line endings and a leading byte order mark do not change the text hash
- the nested projects
- every link, with its origin, mode, the alias of the origin and the signature hash of each symbol the origin publishes

Each nested project has its own lock.

The signature hash catches an AI that changes the signature of an exported function inside `_/` without touching any DMZ file. The DMZ text stays the same, but the signature changes and the check fails.

The AI can edit any file, DMZ files and the config included. It cannot edit the lock. See [The approval flow](./approval) for how a change gets approved, and [Lock file](../reference/lockfile) for the exact shape of the file.

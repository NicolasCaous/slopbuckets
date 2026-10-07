---
title: Concepts
description: Buckets, the _/ folder, the DMZ with .self and .parent, the bucket graph, access rules, the layout, scripts and the lock.
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
4. The `layout` key of the config can limit which bucket folders may exist. `buckets init` writes a layout that allows buckets down to two levels below the root, such as `root/billing/invoices`. See [Layout](#layout).
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

## Access rules

The DMZ decides how code reaches another bucket. Access rules decide which buckets may reach which. They live in the `access` key of `buckets.config.json`, and only a human writes them. Without the key, the check skips them.

```json
{
  "access": {
    "default": "deny",
    "allow": ["** -> root/log"],
    "deny": []
  }
}
```

- `default` is `"allow"` or `"deny"`, and it is required. It decides an edge that no line matches.
- `allow` and `deny` are lists of lines. Both are optional.
- A line `A -> B` means "code in bucket A uses code that originates in bucket B". A is the bucket that imports. B is the origin, the bucket whose `_/` declares the symbol. The check follows the DMZ chain to find it, as [the bucket graph](#the-bucket-graph) describes, so in the example above `invoices` using `logger` is the edge `root/billing/invoices -> root/log`, whatever DMZ files `logger` passes through.

The lines apply to the edges of the bucket graph, which come only from DMZ symbols. A parent that imports from its child through `.self` is an edge too. Imports of packages, Node built-ins and linked projects are not edges, and a bucket that uses its own code never counts.

Under `"default": "deny"`, the `_/` code of a parent needs an allow line to use its children through `.self`. A line such as `root/billing -> root/billing/**` lets the code in `root/billing/_/` use every bucket below it. Without that line, each `.self` import is `access-denied`.

### Patterns

Each side of a line is a pattern over bucket paths. A bucket path is the folder path from the project, as the lock lists it: `root`, `root/log`, `root/teams/search`.

- `**` as a whole segment matches zero or more bucket names. `root/teams/**` matches `root/teams` and every bucket below it, and `**` alone matches every bucket.
- `*` matches any characters inside one name. `root/teams/*` matches each child of `root/teams` but not `root/teams` itself, and `root/team-*` matches `root/team-a`.
- Every other character is literal. `root/teams` matches only that bucket.

::: v-pre
A group of alternatives matches one of its values, as in `root/{api,web}`. Commas separate the values. One name can hold several groups, and the four kinds of group differ in how the groups of one name relate to each other:

| | Repeats allowed | No repeats |
|---|---|---|
| Any order | `{a,b}` | `<a,b>` |
| Sorted, left to right | `{{a,b}}` | `<<a,b>>` |

- `{a,b}`: each group matches any of its values. `root/repository/{A,B,C}+{A,B,C}` matches `root/repository/A+A` and `root/repository/C+B`, but not `root/repository/A+D` or `root/repository/A`.
- `{{a,b}}`: the values of the `{{...}}` groups of one name never decrease from left to right. `root/repository/{{A,B,C}}+{{A,B,C}}` matches `A+A`, `A+B`, `B+B`, `B+C` and `C+C`, but not `B+A` or `C+A`.
- `<a,b>`: the values of the `<...>` groups of one name differ from each other. `root/repository/<A,B,C>+<A,B,C>+<A,B,C>` matches the six orders `A+B+C`, `A+C+B`, `B+A+C`, `B+C+A`, `C+A+B` and `C+B+A`, but not `A+A+B`. The order still matters, so `A+B` and `B+A` are different buckets that both match `<A,B,C>+<A,B,C>`.
- `<<a,b>>`: the values of the `<<...>>` groups of one name increase strictly from left to right. `root/repository/<<A,B,C>>+<<A,B,C>>` matches `A+B`, `A+C` and `B+C`, but not `B+A`, `A+A` or `C+B`. The order of the values decides, not the order of the list, so `<<C,B,A>>+<<C,B,A>>` matches `A+B` too.

The sorted kinds compare values by plain character code, as JavaScript compares strings without a locale, so uppercase letters sort before lowercase ones: `<<a,B>>+<<a,B>>` matches `B+a`, not `a+B`. A name with a single group of any kind matches as if the group were `{a,b}`. One name may use only one of `{{...}}`, `<...>` and `<<...>>`, and mixing two of them is [`config-invalid`](../reference/rules#config-invalid). `{...}` mixes with any of them: `root/r/<<A,B>>-{x,y}-<<A,B>>` matches `root/r/A-x-B` but not `root/r/B-x-A`.

`{{...}}`, `<...>` and `<<...>>` list exact values, so a `*` inside them is `config-invalid`. A value of `{a,b}` may hold a `*`, as in `{api,web-*}`. Groups cannot nest. A `|`, as in `{api|web}`, is `config-invalid` too, because no folder name may contain it on Windows. Separate the values with commas.

A script name in backticks stands for the values that [a script](#scripts) prints. Inside a group of any kind, it is one value between commas, and the script's values join the group and follow its rules: `` root/{shared,`repos`} `` matches `root/shared` and every name that `repos` prints, and `` root/<`repos`>+<`repos`> `` matches two different names it prints. Outside a group, `` `repos` `` means `` {`repos`} ``, so `` root/repository/`repos` `` matches each printed name. A script name mixed with other text in one value, as in `` {a`repos`} ``, is `config-invalid`, and so is a name that `scripts` does not list.
:::

Each side starts with the root path or with `**`. Bucket paths start with the `root` folder of the config, so with `"root": "src/root"` a line reads `src/root/teams/** -> src/root/log`. A side that starts with anything else is [`config-invalid`](../reference/rules#config-invalid). When the root folder moves, the check fails until a human rewrites the lines, instead of letting them match nothing.

The spaces around `->` are optional. The lock and the review write each line as `A -> B`, with one space on each side.

### A worked example

```text
root/
  _/                main.ts wires every module
  log/              the shared logger
  sql/              the database layer
  teams/
    billing/
    payments/
    search/
```

The human writes these rules:

```json
{
  "access": {
    "default": "deny",
    "allow": [
      "root -> root/**",
      "** -> root/log",
      "root/teams/** -> root/sql",
      "root/teams/billing -> root/teams/payments"
    ],
    "deny": [
      "root/teams/search -> root/sql"
    ]
  }
}
```

Line by line:

- `root -> root/**` lets the code in `root/_/` use every bucket, so `main.ts` can wire the modules together. It is also the line a parent needs to use its children through `.self`.
- `** -> root/log` lets every bucket use the logger.
- `root/teams/** -> root/sql` lets every team use the database layer.
- `root/teams/billing -> root/teams/payments` lets billing call payments. No other team may, because no other line matches and `default` is `"deny"`.
- The deny line carves search out of the teams line. Search reads from its own index and must not query the database. Both `root/teams/** -> root/sql` and the deny line match the edge from search to `sql`. The deny line names search exactly, so it is more specific and decides.

| Edge | Result | Decided by |
|---|---|---|
| `root/teams/billing -> root/log` | allowed | `** -> root/log` |
| `root/teams/payments -> root/sql` | allowed | `root/teams/** -> root/sql` |
| `root/teams/search -> root/sql` | `access-denied` | the deny line `root/teams/search -> root/sql` |
| `root/teams/search -> root/teams/payments` | `access-denied` | `default`, because no line matches |

With `"default": "deny"`, every edge the project already has needs an allow line before the check passes again. `buckets inspect --json` lists, for each bucket, the buckets it imports from in `dependsOn`. To add rules to a large project one at a time, start with `"default": "allow"` and a few deny lines.

### Which line decides

Several lines can match one edge. The most specific one decides.

The check counts the segments of each pattern by kind:

::: v-pre
| Count | Segment | Example |
|---|---|---|
| 1st | a literal name | `teams` |
| 2nd | a name with `*`, a group or a script mixed in | `team-*`, `{api,web}`, `{{a,b}}`, `<a,b>`, `<<a,b>>`, `` `repos` `` |
| 3rd | exactly `*` | `*` |
| 4th | `**`, counted as minus one each | `**` |
:::

To compare two patterns, the check compares the first counts. The pattern with more literal names is more specific. When they have the same number, the second counts decide, then the third, then the fourth, where fewer `**` is more specific. Patterns with the same four counts are equally specific.

| Pattern | Counts |
|---|---|
| `root/log` | 2, 0, 0, 0 |
| `root/billing` | 2, 0, 0, 0 |
| `root/billing/**` | 2, 0, 0, -1 |
| `root/teams/**` | 2, 0, 0, -1 |
| `root/**/payments` | 2, 0, 0, -1 |
| `root/**` | 1, 0, 0, -1 |
| `**/log` | 1, 0, 0, -1 |

So `root/log` beats `root/**`, and `root/billing` beats `root/billing/**`. Where a segment sits in the pattern does not matter. `root/**/payments` and `root/teams/**` are equally specific, and so are `**/log` and `root/**`. When two such patterns sit in an allow line and a deny line with the same other side, the edge they both match is ambiguous.

A line beats another line when it is at least as specific on both sides and more specific on at least one. For each edge, the check:

1. collects every line of both lists that matches the edge
2. drops every line that another matching line beats
3. lets `default` decide when no line matched
4. lets the list decide when the lines left all come from that list
5. fails the edge with `access-ambiguous` when lines from both lists are left

The order of the lines in a list does not matter. The lock stores each list sorted, so moving a line up or down needs no approval. When a message names one of several lines left, it names the first in sorted order.

Three short cases follow.

An exception under `"default": "allow"`. Teams do not use each other, except billing, which calls payments:

```json
"default": "allow",
"allow": ["root/teams/billing -> root/teams/payments"],
"deny": ["root/teams/* -> root/teams/*"]
```

For `root/teams/billing -> root/teams/payments`, each side of the allow line has three literal names, where each side of the deny line has two. The allow line beats the deny line, and billing may call payments. For `root/teams/search -> root/teams/payments`, only the deny line matches.

A carve-out on one side. In the worked example, the deny line `root/teams/search -> root/sql` and the allow line `root/teams/** -> root/sql` have the same right side. On the left side, `root/teams/search` has three literal names and `root/teams/**` has two. The deny line is more specific on one side and as specific on the other, so it wins.

An ambiguous edge. Search may use anything, and nobody may use the database directly:

```json
"allow": ["root/teams/search -> root/**"],
"deny": ["root/** -> root/sql"]
```

For `root/teams/search -> root/sql`, the allow line is more specific on the left side and the deny line is more specific on the right side. Neither beats the other, so the check fails the edge with `access-ambiguous` and names both lines. A human settles it with a line that is at least as specific as both on both sides. A line that names both buckets always works: `root/teams/search -> root/sql` in `allow` lets search query the database, and the same line in `deny` forbids it.

The same line in both lists is `config-invalid`, and so is a line listed twice in one list. Overlapping patterns in the two lists are fine, because that is how an exception works.

### When an import is denied

`buckets check` exits with code 1 and reports the rule on the import line. Here the search team imported `query` from the database layer:

```text
root/teams/search/_/rank.ts
  line 2  access-denied
    Access denied: root/teams/search -> root/sql. This file imports `query` (declared in root/sql) from root/teams/dmz/.parent/search.ts, so code in root/teams/search uses code from root/sql. The line "root/teams/search -> root/sql" in access.deny of buckets.config.json is the most specific line that matches this edge. The re-export chain is root/teams/dmz/.parent/search.ts -> root/dmz/sql/teams.ts -> root/sql/_/query.ts. buckets.config.json belongs to a human, so an AI agent never edits it. Remove this dependency on root/sql (the import of `query` and the code that uses it), or stop and ask the human to change "access" in buckets.config.json.
```

The check also looks at DMZ files before any code imports them. When a DMZ file re-exports a symbol that no bucket allowed to import that file may use, it reports the rule on the export line of the DMZ file. A `.parent` or `.external` file is skipped, because its consumers live outside the bucket.

The agent cannot edit `buckets.config.json`, because the [hooks](./claude-code#the-lock-guard) deny every write to it, as they do for the lock. It has two ways out:

- remove the dependency and solve the task with the buckets it may use
- stop and ask the human, with the exact line it proposes and why, such as "add `root/teams/search -> root/sql` to `access.allow`, so search can read live prices"

For `access-ambiguous`, the message names the allow line and the deny line, and the agent asks the human for a line more specific than both.

`access-unknown-bucket` reports a side without `*` or `{` that names no bucket, which usually means a bucket folder was renamed, moved or deleted. A pattern with wildcards that matches nothing is not an error.

Every rule id and its messages are on the [rules reference](../reference/rules#access-rules).

### Changing the rules

A human edits `buckets.config.json` and approves the change like any other. The lock keeps the whole config, so the check reports `config-changed` with exit code 2. The text report of `buckets check` and the review list each line that changed:

```text
~ config changed          buckets.config.json
    + access.allow  root/teams/search -> root/sql
    - access.deny   root/teams/search -> root/sql
```

Locks written before version 4 kept only a hash of the config. When the config changed since such a lock, the review shows the whole current config instead and says the old values were not recorded. See [The approval flow](./approval#config-changes).

## Layout

Access rules decide which buckets may use which. The layout decides which bucket folders may exist. It lives in the `layout` key of `buckets.config.json`, and only a human writes it. Without the key, any bucket folder may exist.

```json
{
  "layout": {
    "default": "deny",
    "allow": ["root/gpu/*", "root/*/*"],
    "deny": ["root/legacy/**"]
  }
}
```

The layout has the shape of `access`, with one pattern per line instead of two:

- `default` is `"allow"` or `"deny"`, and it is required. It decides a bucket folder that no line matches.
- `allow` and `deny` are lists of patterns over bucket paths, with the syntax of [access patterns](#patterns). Both are optional. Each pattern starts with the root path or with `**`.
- The most specific matching line decides, counted as in [Which line decides](#which-line-decides). An allow line and a deny line that are equally specific make the folder `layout-ambiguous`.

A bucket also passes when no line allows it, if no deny line matches it and some allow line can match a bucket below it. So a layout that allows a bucket also lets its parents exist. `"allow": ["root/gpu/*"]` lets `root`, `root/gpu` and every child of `root/gpu` exist, and nothing else. `"allow": ["root/*/*"]` lets `root`, `root/billing` and `root/billing/invoices` exist, but not `root/billing/invoices/pdf`.

With the layout above:

| Bucket folder | Result | Decided by |
|---|---|---|
| `root/gpu/cuda` | allowed | `root/gpu/*` |
| `root/billing/invoices` | allowed | `root/*/*` |
| `root/billing` | allowed | `root/*/*` matches buckets below it |
| `root/billing/invoices/pdf` | `layout-denied` | `default`, because no line matches it or a bucket below it |
| `root/legacy` | `layout-denied` | the deny line `root/legacy/**` |

`buckets init` writes `"layout": {"default": "deny", "allow": ["root/*/*"]}` with the root path of the project, so a new project allows buckets down to two levels below the root. Older configs limited the depth of the tree with a field of their own. The check now reports that field as [`config-invalid`](../reference/rules#config-invalid), and the message gives the layout that allows the same folders.

The check reports `layout-denied` or `layout-ambiguous` on the bucket folder. A folder that fails is not a bucket, and the check does not look inside it, so a misplaced subtree gives one violation. The root bucket always exists. A layout that forbids it is reported, and the check goes on.

The agent cannot change the layout. It moves the folder into the `_/` of its parent when the folder only organizes code, removes it, or stops and asks the human for the exact line it proposes, such as "add `root/billing/invoices/pdf` to `layout.allow`". Every rule id and its messages are on the [rules reference](../reference/rules#layout).

## Scripts

A list of names that changes often, such as the repositories of a team, can live in a file instead of the config. A script prints the list, and access and layout lines name the script in backticks. The `scripts` key of `buckets.config.json` maps each script name to a Node script, relative to the folder of the config:

```json
{
  "scripts": { "repos": "tools/repos.mjs" },
  "layout": {
    "default": "deny",
    "allow": ["root/repository/{shared,`repos`}"]
  }
}
```

```js
// tools/repos.mjs prints the name of each repository in repos.json, one per line.
import { readFileSync } from 'node:fs';

for (const repo of JSON.parse(readFileSync('repos.json', 'utf8'))) console.log(repo.name);
```

A script name starts with a letter or `_` and holds only letters, digits, `_` and `-`. The file must exist, and the paths of `scripts` are part of the config like any other value.

The check runs each script before it matches any line, as `node <file>` with the project folder as the current folder, no arguments and a 10 second timeout. Each script runs once per process, so the check, `buckets check --file` and each agent hook run it once. There is no sandbox: a script can do anything a Node program can, so keep it small and read only files of the project.

Each line of the output is one value. The check strips a trailing `\r` and skips empty lines. A value must be a valid bucket name: no `/` or `\`, no `*`, `{`, `}`, `<`, `>`, `,`, `|` or backtick, no character that Windows forbids in a folder name, no space at either end, no leading `.`, and not `_` or `dmz`. The order of the lines and repeated lines do not matter.

The check reports [`config-invalid`](../reference/rules#config-invalid) with the script name and the first lines of its stderr when a script exits with a code other than 0, runs longer than 10 seconds, prints no value or prints an invalid value. It matches no line until every script works.

The lock stores the output of each script in `scriptValues`, sorted and without repeats, next to the config. A script that prints other values, for example after `repos.json` changed, is a `config-changed` lock difference even when `buckets.config.json` is the same, so a new value waits for a human approval like a new line. The review lists the values added and removed per script:

```text
~ config changed          buckets.config.json
    + `repos` output  billing-api
    - `repos` output  old-web
```

## The lock

`buckets.lock.json` records the last state a human approved:

- the CLI version, and the adapter name, version and toolchain (such as `typescript@5.9.3`) that wrote it
- the bucket tree
- the config with the defaults filled in and its keys sorted, `access` included, so a change in formatting alone does not count. Locks older than version 4 kept only a hash of it
- the values each script of the config printed
- for every DMZ file, `.external.ts` files included, a hash of its text and a hash of the type signature of each symbol it re-exports. Line endings and a leading byte order mark do not change the text hash
- the nested projects
- every link, with its origin, mode, the alias of the origin and the signature hash of each symbol the origin publishes

Each nested project has its own lock.

The signature hash catches an AI that changes the signature of an exported function inside `_/` without touching any DMZ file. The DMZ text stays the same, but the signature changes and the check fails.

The AI can edit any file, DMZ files included. It cannot edit the lock or `buckets.config.json`, because a human owns both. See [The approval flow](./approval) for how a change gets approved, and [Lock file](../reference/lockfile) for the exact shape of the file.

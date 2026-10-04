---
title: Projects and links
description: Nested projects with their own config, lock and tsconfig, and links that bring the source of another project into a bucket, like a git submodule.
---

# Projects and links

A repository, or a machine, can hold several slopbuckets projects. Each project has its own `buckets.config.json`, root folder, alias, `tsconfig.json` and `buckets.lock.json`. Projects never import each other's files directly. To share code, one project publishes it in `.external.ts` files, and the other project links it.

A link works like a git submodule. It brings the source code of the other project into a bucket, unchanged, and the project that consumes it compiles and runs that code with its own tools. Values and types both cross a link. slopbuckets compiles nothing.

## Nested projects

A nested project is a folder with its own `buckets.config.json` inside some bucket's `_/` folder:

```text
buckets.config.json             the repo project, alias @root-k3x9pm2a
buckets.lock.json
tsconfig.json
root/
  store/
    _/
      db.ts
      engine/                   a nested project
        buckets.config.json     alias @root-m4tw8cjq
        buckets.lock.json
        tsconfig.json
        root/
          core/_/
          io/_/
  web/
    _/
      page.ts
      kit/                      another nested project, alias @root-9ajxwndv
```

The rules for nested projects:

- A nested project may live only in a subfolder of a bucket's `_/`. A `buckets.config.json` anywhere else inside the root folder fails the check with [`project-misplaced`](../reference/rules#project-misplaced).
- The enclosing project does not scan the nested folder, and its adapter does not read it. The enclosing lock only records that a project exists at that path, so a new or deleted nested project is a lock difference ([`project-added`](../reference/lock#project-added), [`project-removed`](../reference/lock#project-removed)).
- The two projects never import each other's files. An import from `root/store/_/db.ts` into `root/store/_/engine/` fails with `import-forbidden`, and the message explains how to publish the code and link it instead. A project shares code with a nested project, in either direction, only through a [link](#links).
- A nested project needs its own alias. Reusing the alias of any enclosing project fails the check of the nested project with [`config-invalid`](../reference/rules#config-invalid), because its imports would resolve into the wrong project.

To create one, put a `tsconfig.json` in the new folder and run `buckets init` there:

```sh
mkdir -p root/store/_/engine
cd root/store/_/engine
# write tsconfig.json and package.json for the new project
buckets init
```

`init` finds the enclosing project and generates an alias that no enclosing project uses, such as `@root-m4tw8cjq`. It refuses an alias that an enclosing project already uses. It skips the Claude Code hooks and the skill, because the hooks of the enclosing project already check nested projects. Run it somewhere else inside the root folder of another project, outside a bucket's `_/`, and it refuses and writes nothing.

### Each project has its own tsconfig.json

slopbuckets never reads the `tsconfig.json` of an enclosing project. A project without a `tsconfig.json` in its own folder stops the check with the environment code [`no-tsconfig`](../reference/lock#no-tsconfig), nested projects included.

The two configs must not overlap. The build of the enclosing project would otherwise compile the files of the nested project with the wrong settings and the wrong alias:

- `buckets init` in a nested project adds its folder to `exclude` in the `tsconfig.json` of the enclosing project, such as `"exclude": ["root/store/_/engine"]`. When it cannot edit the file safely, it prints the line to add by hand.
- While the `include` of the enclosing project still reaches a nested project, or its `files` list one of its files, the check of the enclosing project fails with [`project-config`](../reference/rules#project-config) and says which entry to add or remove.
- The check of every project also fails with `project-config` when its `tsconfig.json` does not cover its own root bucket folder: the folder is missing from `include`, an `exclude` entry leaves it out, or `rootDir` points elsewhere.

### Checking several projects

`buckets check` checks the current project and every project nested in it, at any depth, each against its own lock. It never walks up to a parent project.

- The text report has one section per project with problems, such as `== Project root/web/_/kit (nested, paths below are relative to it)`.
- In `--json`, every violation and lock difference has a `project` field, and `projects` lists each project with its own exit code. See [Check report](../reference/report).
- The exit code is 3 when any project has an environment problem, else 1 when any project breaks a rule, else 2 when any project differs from its lock, else 0.
- `buckets check --no-recursive` checks only the current project.
- `buckets check --file <path>` checks the file in its nearest project.

`buckets refresh` asks project by project, and `buckets refresh --web` shows one section per project. A human approves each project on its own, and each approval writes only that project's lock.

The check keeps an analysis cache in `.buckets/cache/` of the project where it ran. A project whose files did not change skips the adapter on the next run. The `.buckets/` folder ignores itself with its own `.gitignore`, so you do not have to add it to yours.

## Links

The rest of this page follows one example. `billing` is a project in a sibling folder of `shop`. `shop` wants to create invoices with code from `billing`.

```text
billing/                         origin, alias @root-p7hq2wxe
  buckets.config.json
  package.json
  tsconfig.json
  root/
    dmz/invoices/.external.ts    what billing publishes
    invoices/_/invoice.ts
    invoices/_/money.ts
shop/                            consumer, alias @root-k3x9pm2a
  buckets.config.json
  tsconfig.json
  root/
    web/_/page.ts
```

The steps:

1. `billing` publishes `createInvoice` and `Invoice` in a `.external.ts` file.
2. `shop` runs `buckets link add` in the bucket that needs them.
3. Code in that bucket imports them through the alias of `billing` and its `.external.ts` file.
4. A human approves the new link in `shop`.

### Unique aliases

Code imports a linked project through that project's own alias, so two linked projects must never share one. `buckets init` generates a unique alias for every new project: `@`, the name of the root bucket folder, a dash and 8 random lowercase letters and digits, such as `@root-k3x9pm2a`. The interactive `init` lets you type another one.

Projects set up with older versions use `@root`. They keep working on their own, but `buckets link add` refuses to link a project whose alias is the alias of the consumer, or of another link of the consumer. The message says how to change the alias of one of the two projects: edit `alias` in its `buckets.config.json`, update its imports and its `tsconfig.json` paths (`buckets init` sets the paths), and have a human approve the change.

## Publish with .external.ts

A bucket publishes code to other projects with a `.external.ts` file in the `dmz/` folder of its parent, next to its other contracts. Here `billing` publishes from its bucket `invoices`:

```ts
// billing/root/dmz/invoices/.external.ts
export { createInvoice } from '@root-p7hq2wxe/invoices/_/invoice';
export type { Invoice } from '@root-p7hq2wxe/invoices/_/invoice';
```

```ts
// billing/root/invoices/_/invoice.ts
import { round } from '@root-p7hq2wxe/invoices/_/money';

export interface Invoice {
  id: string;
  total: number;
}

export function createInvoice(id: string, amounts: number[]): Invoice {
  return { id, total: round(amounts.reduce((a, b) => a + b, 0)) };
}
```

The rules for a `.external.ts` file:

- It follows the DMZ syntax: only `export { name } from` and `export type { Name } from`, re-exported from the surface of that bucket.
- Its consumers live in other projects, so the orphan rule skips it, and the symbols behind it count as used.
- It is a DMZ file of `billing`, so the lock of `billing` pins its text and the signature of each symbol. A new or changed `.external.ts` is a lock difference in `billing` ([`dmz-added`](../reference/lock#dmz-added), [`symbol-added`](../reference/lock#symbol-added), [`signature-changed`](../reference/lock#signature-changed)), and a human of `billing` approves what it publishes.
- Consumers may import only these files. Anything they need, value or type, must be in a `.external.ts` file.

The rest of `billing`, such as `money.ts`, stays private. It still travels with the link, because `invoice.ts` imports it.

## Link a project

In `shop`, run `buckets link add` with a name for the link and the folder of the origin project, the one that holds its `buckets.config.json`. Run it inside the bucket that uses the code, or pass `--bucket`. Both paths are relative to the current folder:

```sh
cd shop
buckets link add billing ../billing --bucket root/web
```

<div class="msg" v-pre>Created root/web/_/links/billing as a junction to ../billing/root/ and added it to .gitignore. Other clones recreate it with `buckets link sync`.<br>Registered it in buckets.links.json with the alias @root-p7hq2wxe.<br>Added "@root-p7hq2wxe/*": ["./root/web/_/links/billing/*"] to "compilerOptions.paths" in tsconfig.json.<br>Added "exclude": ["root/web/_/links/billing"] to tsconfig.json, so `tsc` here compiles only the linked files that code imports, not the whole linked project.<br>Code in root/web/_/ imports the linked project only through its published files: '@root-p7hq2wxe/dmz/invoices/.external'. Values and types are both allowed. Importing any other file of the link fails the check with link-forbidden-import.<br>The packages the linked files import must resolve in two places. ...<br>The check fails with exit code 2 until a human approves the change with `buckets refresh` (an agent asks with `buckets refresh --web`).</div>

`link add` changed these files in `shop`:

| File | Change |
|---|---|
| `root/web/_/links/billing` | a junction on Windows, or a folder symlink on macOS and Linux, to `../billing/root/`, the root bucket folder of `billing` |
| [`buckets.links.json`](../reference/links) | the link, with the origin `../billing`, the mode `link` and the alias `@root-p7hq2wxe` |
| `.gitignore` | the line `/root/web/_/links/billing`, because a link in `link` mode stays out of git |
| `tsconfig.json` | the alias of `billing` in `compilerOptions.paths`, pointing at the link folder, and the link folder in `exclude` |

The part of the `tsconfig.json` of `shop` that slopbuckets manages now reads:

```json
{
  "compilerOptions": {
    "paths": {
      "@root-k3x9pm2a/*": ["./root/*"],
      "@root-p7hq2wxe/*": ["./root/web/_/links/billing/*"]
    },
    "noUnusedLocals": true
  },
  "include": ["root"],
  "exclude": ["root/web/_/links/billing"]
}
```

The `paths` entry makes `@root-p7hq2wxe/...` resolve inside the link, both in `shop` and in the linked files, which import their own code through the same alias. The `exclude` entry keeps `tsc` from compiling all of `billing`: it compiles only the linked files that `shop` imports, and the files they import. `link add` edits the file in place and keeps its comments. When it cannot edit the file safely, it prints the lines to add by hand.

Other rules of `link add`:

- The origin must be a whole slopbuckets project. A path to a `.external.ts` file, or to a folder inside a project, is refused, and the message names the project folder to pass instead.
- A project can be linked once per consumer project, because one alias maps to one folder. When a second bucket needs the same project, re-export what it needs from the bucket that owns the link through a DMZ contract, or move the link.
- The origin is stored relative to the project. When the origin is on another drive, the path is absolute and works only on the machine that wrote it, and `link add` prints a warning.
- When `billing` has no `.external.ts` file yet, `link add` still creates the link, and says that the origin publishes nothing yet.

### Link mode and copy mode

| Mode | What the link folder holds | In git | When to use |
|---|---|---|---|
| `link` | a junction or folder symlink to the root bucket folder of the origin | no, it is in `.gitignore` | the origin is in the same repository, so every clone and CI can recreate the link |
| `copy` | a copy of the origin's `.external.ts` files and every file they import, in the same paths | yes, commit it | the origin is somewhere CI cannot see, such as another repository or another machine |

`link add` tries `link` mode first and falls back to a copy when the system refuses to create a link. A project nested inside the root folder of its origin always gets a copy, because a link there would contain the project itself.

### Copy only the published files with --copy

`--copy` asks for a copy. It does not copy the whole project. It starts at the `.external.ts` files and follows every import through the origin's alias or a relative path, so the copy holds exactly the files the published symbols need. Packages are not copied.

```sh
buckets link add billing ../billing --bucket root/web --copy
```

```text
root/web/_/links/billing/
  dmz/invoices/.external.ts
  invoices/_/invoice.ts
  invoices/_/money.ts
```

The files keep their content byte for byte and their paths relative to the root folder of `billing`, so the same imports work in the copy. Commit the copy. `buckets link update billing` copies the origin again.

## Import through the alias

Code in the bucket that owns the link imports the linked project through the origin's alias and its `.external.ts` files. Values and types are both allowed:

```ts
// shop/root/web/_/page.ts
import { createInvoice, type Invoice } from '@root-p7hq2wxe/dmz/invoices/.external';

export function checkout(amounts: number[]): Invoice {
  return createInvoice('web-1', amounts);
}
```

Any other file of the link is off limits, even when it exports what you need. An import of `money.ts` fails the check:

<div class="msg" v-pre>root/web/_/page.ts<br>&nbsp;&nbsp;line 2  link-forbidden-import<br>&nbsp;&nbsp;&nbsp;&nbsp;Import of root/web/_/links/billing/invoices/_/money.ts reaches inside the linked project in root/web/_/links/billing. Code may import a linked project only through its published .external.ts files, such as '@root-p7hq2wxe/dmz/invoices/.external'. If the symbol you need is not published, it must be added to a .external.ts file in the origin project, which that project's human approves.</div>

The same rule applies to a DMZ file of `shop` that re-exports from a link: it may point only at a `.external.ts` file of the link. See [`link-forbidden-import`](../reference/rules#link-forbidden-import).

The files inside a link are not checked against the rules of `shop`, because `billing` checks them against its own rules. They are still part of the TypeScript program of `shop`, so the check sees their types and the signatures they publish. Never edit files in `_/links/`: a link in `link` mode is the origin itself, and a copy is overwritten by the next `link update`.

## Dependencies on both sides

The packages that the linked files import must resolve wherever a tool looks for them. A tool looks up a package from the folder of the file that imports it, and a junction gives each linked file two folders:

| Mode | Type checking (`tsc` in `shop`) | Runtime (Node and bundlers) |
|---|---|---|
| `link` | reads the file through the link path, so it looks in the `node_modules` folders of `shop` | follows the junction to the real path, so it looks in the `node_modules` folders of `billing` |
| `copy` | the copy lives in `shop`, so it looks in `shop` | looks in `shop` too |

So in `link` mode, install each package in `billing` for runtime, with `npm install` there, and install it or its `@types` package in `shop` for type checking, for example as a devDependency. In copy mode, add the packages to the `package.json` of `shop`. A package that a linked file imports only with `import type` is erased before runtime and needs only the type checking side.

The check resolves every package that a linked file imports, from both places, and reports each one that is missing as [`link-missing-dependency`](../reference/rules#link-missing-dependency) (exit code 1). The message names the package, the file and the side that lacks it:

<div class="msg" v-pre>root/web/_/links/billing/invoices/_/money.ts<br>&nbsp;&nbsp;link-missing-dependency<br>&nbsp;&nbsp;&nbsp;&nbsp;root/web/_/links/billing/invoices/_/money.ts, a file of the project linked in root/web/_/links/billing, imports the package "decimal.js", which is missing for type checking and at runtime. root/web/_/links/billing is a junction to the project ../billing. Missing for type checking: ... install it in this project, the consumer, for example with `npm install --save-dev decimal.js` ... Missing at runtime: ... run `npm install` in ../billing, where "decimal.js" belongs in package.json. Then run `buckets check` again.</div>

When a linked file imports through the alias of a third project that `billing` links, `shop` has no such alias, and the check reports the same rule with the `buckets link add` command that links that project in `shop` too.

## Bundlers

TypeScript reads the alias from `tsconfig.json`. A bundler needs it in its own config. `link add` never edits a bundler config. When it finds one in the project folder, it prints the setting to add:

<div class="msg" v-pre>Bundler configs found. slopbuckets does not edit them; add the alias yourself:<br>&nbsp;&nbsp;vite.config.ts (Vite): add the alias to "resolve.alias", with `import { fileURLToPath } from 'node:url'` at the top:<br>&nbsp;&nbsp;&nbsp;&nbsp;resolve: { alias: { '@root-p7hq2wxe': fileURLToPath(new URL('./root/web/_/links/billing', import.meta.url)) } }<br>&nbsp;&nbsp;next.config.mjs (Next.js): next dev and next build read "compilerOptions.paths" from tsconfig.json, so the tsconfig.json entry is enough. A custom webpack function in next.config.mjs needs the alias too:<br>&nbsp;&nbsp;&nbsp;&nbsp;webpack: (config) =&gt; { config.resolve.alias['@root-p7hq2wxe'] = path.resolve(__dirname, './root/web/_/links/billing'); return config; }<br>&nbsp;&nbsp;webpack.config.js (webpack): add the alias to "resolve.alias":<br>&nbsp;&nbsp;&nbsp;&nbsp;resolve: { alias: { '@root-p7hq2wxe': path.resolve(__dirname, './root/web/_/links/billing') } }</div>

| Bundler | Configs it looks for | What to add |
|---|---|---|
| Vite | `vite.config.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` | the alias in `resolve.alias`, pointing at the link folder |
| Next.js | `next.config.ts`, `.mjs`, `.js`, `.cjs` | nothing for `next dev` and `next build`, which read `paths` from `tsconfig.json`. A custom `webpack` function needs the alias in `config.resolve.alias` |
| webpack | `webpack.config.ts`, `.js`, `.mjs`, `.cjs` | the alias in `resolve.alias` |

Any other tool that resolves imports at build time or runtime needs the same mapping: the origin's alias to the link folder. `buckets link remove` reminds you to take the alias out of the bundler config again.

## Approvals

`buckets link` never writes the lock. It writes `buckets.links.json`, which is not an approval. The lock of `shop` records each approved link with its origin, mode and alias, and the signature hash of every symbol that `billing` publishes:

| What happened | Lock difference in `shop` |
|---|---|
| `link add` | [`link-added`](../reference/lock#link-added) |
| `link remove` | [`link-removed`](../reference/lock#link-removed) |
| The origin, mode or alias of a link changed | [`link-changed`](../reference/lock#link-changed) |
| `billing` published a new symbol, removed one, or changed the signature of one | `link-changed`, once per symbol |
| `billing` changed code without changing a published signature | nothing |

So a human of `shop` approves only what `shop` depends on: the published signatures. A change to `money.ts`, or to the body of `createInvoice`, reaches `shop` through a junction right away, and needs no approval in `shop`. A changed signature does, even when it comes from a type the published symbol uses. Adding a field to `Invoice` changes the signature of `createInvoice` too:

```text
Lock differences
  Only a human approves these, with `buckets refresh` or `buckets refresh --web`.
  ~ link-changed  root/web/_/links/billing  Invoice
  ~ link-changed  root/web/_/links/billing  createInvoice
```

Before that, the change already needed the approval of a human of `billing`, because it changed a symbol of its `.external.ts`. A published contract that changes is approved twice: in the project that publishes it, and in each project that consumes it. The agent asks for each one with `buckets refresh --web`, and the page has one section per project when both are in the same tree. See [The approval flow](./approval).

## Keep links current

| Situation | What the check reports | What to run |
|---|---|---|
| A link in `buckets.links.json` is not on disk, for example after a clone | [`link-missing`](../reference/rules#link-missing), exit code 1 | `buckets link sync` |
| A published signature of the origin changed | [`link-changed`](../reference/lock#link-changed), exit code 2 | ask for approval |
| A file of a copy differs from its origin | [`link-drift`](../reference/lock#link-drift), exit code 2 | `buckets link update <name>`, then `buckets check` |
| The origin of a copy is not on this machine | nothing, the committed copy counts | nothing |

The commands:

- `buckets link sync` recreates every missing link of the current project and its nested projects, from `buckets.links.json`. It leaves existing copies alone. `--no-recursive` limits it to the current project.
- `buckets link update [name]` copies the origin of links in copy mode again. Without a name it updates every copy. A link in `link` mode needs no update, because it already shows the origin as it is.
- `buckets link remove <name>` deletes the link folder and its entry, its `.gitignore` line, and its `paths` and `exclude` entries in `tsconfig.json`.

`link-drift` lists the files that differ. After `link update`, the check passes again when the published signatures did not change. When they did, it reports `link-changed`, which needs approval.

After `link remove`, remove the imports of the alias too. Until a human approves the removal, the check reports each import that is left as `import-unresolved`, and the message says that the link was removed. Every message of the `buckets link` commands is on the [Links registry](../reference/links#what-buckets-link-prints) page.

## Git and CI

Commit these files:

- every `buckets.config.json`, `buckets.lock.json` and `tsconfig.json`, nested ones included
- `buckets.links.json`
- the `.external.ts` files
- link folders in copy mode

Links in `link` mode stay out of git. A fresh clone, and every CI job, has to recreate them before anything reads them. Install the dependencies of the origin too when a link in `link` mode points at a project with its own `package.json`, because the check resolves the runtime side from there:

```sh
npm ci
npx slopbuckets@$(node -p "require('./buckets.lock.json').cli") link sync
npm run build
npx slopbuckets@$(node -p "require('./buckets.lock.json').cli") check
```

Run `link sync` before the build too, because the build compiles the linked files. A link whose origin lives outside the repository cannot be recreated in CI. Use copy mode for those. See [CI](./ci).

## A full example

The nested project `kit`, in `root/web/_/kit`, publishes `Theme`, and the repo project uses it in `web`.

1. In `kit`, the agent writes `root/dmz/theme/.external.ts`. The check of `kit` reports `dmz-added` for the new contract.
2. In the repo project, the agent runs `buckets link add kit _/kit` inside `root/web` and writes `import type { Theme } from '@root-9ajxwndv/dmz/theme/.external'`. The check reports `link-added`.
3. `buckets check` from the repo root exits with code 2, with one section per project.
4. The agent runs `buckets refresh --web`. The page has a section for the repo project and one for `kit`. The human approves each one with its own confirmation code.

Later, someone renames a field of `Theme` in `kit`. The check of `kit` reports `signature-changed`, and the repo project reports `link-changed` on `Theme`. Both go through approval again, so a contract change in one project never reaches another one without a human seeing it. A fix inside `kit` that keeps `Theme` as it is needs no approval in either project.

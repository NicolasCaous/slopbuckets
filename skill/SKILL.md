---
name: slopbuckets
description: Rules for working in a project that uses slopbuckets (has a buckets.config.json). Use before editing any file under the root bucket folder, before adding an import between folders, and whenever buckets check fails.
---

# Working in a slopbuckets project

This project is split into buckets. Each bucket is a sealed folder. You can write any code inside a bucket. Code in one bucket reaches another bucket only through contract files in `dmz/` folders, and a human approves every contract change.

Read `buckets.config.json` to find the root bucket folder (`root` by default), the import alias, the `access` rules and the `layout`. Never edit it: it belongs to the human. `buckets init` generates a unique alias such as `@root-k3x9pm2a`; older projects use `@root`. The examples below write `@root`.

## Reading the structure before you edit

Run `buckets inspect --json` to see the whole project before you change contracts or add imports between buckets. It prints one JSON object and exits:

- `projects`: the current project first (`.`), then every nested project, each with its `buckets`, `contracts`, `imports`, `violations`, `lockChanges`, `links` and `external` surface.
- `buckets[]`: `offers` and `consumes` list the DMZ files of each bucket, `dependsOn` and `dependents` list the buckets it imports from and the buckets that import from it, and `rewriteCost` says how many contract symbols a rewrite must keep.
- `contracts[].symbols[]`: `origin` is the bucket that declares the symbol, `chain` lists the files from the DMZ file to the declaration, `signature.text` is the declaration and `importers` lists every `_/` file that imports it, with the line.
- `violations[]` carries the same messages as `buckets check`, plus `cycle`, `chain` (for orphans) or `target` (for forbidden imports).

Use it to find the DMZ file a symbol already passes through, or the shortest path for a new one, instead of opening files one by one. `buckets inspect` without `--json` serves the same data as a read-only page on `127.0.0.1` for the human. It never writes to the project and never approves anything, so you may run either form at any time.

When the human asks for a picture of the structure, `buckets inspect --export mermaid` prints the bucket graph of every project as a Mermaid flowchart and `buckets inspect --export svg` prints the map, both without a server. When the human wants the whole page to share, `buckets inspect --export html --out inspect.html` writes it as one HTML file that works without a server. Add `--out <file>` to write a file instead of printing. It refuses to write over `buckets.lock.json`.

## Folder rules

- A bucket contains only `_/`, `dmz/` and child buckets.
- All code of a bucket lives in its `_/` folder. Inside `_/` you can create any files and folders.
- Every other folder inside a bucket is a child bucket. Do not create one to organize code. Creating a bucket needs human approval, and the `layout` of the config may forbid it.
- Do not put files directly in a bucket folder.
- Do not create symlinks or junctions inside the root folder. `buckets link add` is the only way to place a link, in `<bucket>/_/links/<name>`.

## Import rules

- Use the alias for every internal import. Never use relative imports, not even inside the same `_/` folder.
- Code in `X/_/` can import from:
  - `X/_/`
  - DMZ files of the parent bucket where `X` is the consumer: `P/dmz/<provider>/X.ts`
  - DMZ files where a child of `X` provides to `X`: `X/dmz/<child>/.self.ts`
  - packages listed in `package.json` and Node built-ins
- Never use `import()`, `require()`, `createRequire`, `import.meta.glob` or `import * as` from a DMZ file. `vi.mock`, `jest.mock` and `new URL('...', import.meta.url)` follow the same rules as an import of their string.
- Never share code without imports: every file in `_/` is a module, with no `declare global`, no `export as namespace` and no `/// <reference>`. `declare module '@root/...'` counts as an import of that file. Keep ambient declaration files such as `vite-env.d.ts` outside the root folder.
- Importing a DMZ symbol counts as a use only if the code references it. Re-exporting it from `_/` counts only when another file of the same bucket imports it from there and references it.

## DMZ rules

Inside `P/dmz/`, the folder is the provider and the file is the consumer. `dmz/sql/http.ts` holds everything `http` takes from `sql`. `.self` means the code in `P/_/`. `.parent` means what `P` receives from the level above.

A DMZ file contains only these two kinds of statements:

```ts
export { query } from '@root/sql/_/query';
export type { Row } from '@root/sql/_/types';
```

No renames with `as`, no `export *`, no default exports, no declarations, no logic.

When a bucket needs something from another bucket, add the symbol to the right DMZ file, creating the file if needed. To reach a bucket that is not a sibling, add one re-export per level, so every hop is a file. Every DMZ symbol must be used by some code. Remove contracts that nothing uses anymore, and remove the whole chain, not only the last file.

The bucket graph cannot have cycles. If bucket A uses something from B, B cannot use anything from A, directly or through other buckets.

## Access rules

`buckets.config.json` may have an `access` key that says which buckets may use which:

```json
"access": {
  "default": "deny",
  "allow": ["** -> root/log", "root/teams/** -> root/sql"],
  "deny": ["root/teams/search -> root/sql"]
}
```

A line `A -> B` means code in bucket A uses code declared in bucket B's `_/`, whatever DMZ files the symbol passes through. Bucket paths start with the root folder, such as `root/teams/search`. Each side is a pattern, and each pattern starts with the root path or with `**`:

| Pattern | Matches | Example |
|---|---|---|
| `**` | zero or more bucket names | `root/teams/**` matches `root/teams` and every bucket below it |
| `*` | any characters inside one name | `root/team-*` matches `root/team-a` |
| `{a,b}` | one of the alternatives | `root/{api,web}` matches `root/api` and `root/web` |
| `{{a,b}}` | one of the alternatives, and the `{{...}}` groups of one name match values that never decrease | `root/{{A,B,C}}+{{A,B,C}}` matches `root/A+A` and `root/A+B`, not `root/B+A` |
| `<a,b>` | one of the alternatives, and the `<...>` groups of one name match different values | `root/<A,B,C>+<A,B,C>` matches `root/A+B` and `root/B+A`, not `root/A+A` |
| `<<a,b>>` | one of the alternatives, and the `<<...>>` groups of one name match values in strictly increasing order | `root/<<A,B,C>>+<<A,B,C>>` matches `root/A+B`, `root/A+C` and `root/B+C`, not `root/B+A` |
| `` `name` `` | the values the script `name` of `scripts` prints, as one value of a group or, alone, as `` {`name`} `` | `` root/{shared,`repos`} `` matches `root/shared` and each repository name that `repos` prints |

The four kinds of group differ in whether the groups of one name may repeat a value and whether their values must be sorted from left to right:

| | Repeats allowed | No repeats |
|---|---|---|
| Any order | `{a,b}` | `<a,b>` |
| Sorted, left to right | `{{a,b}}` | `<<a,b>>` |

Separate alternatives with commas. A `|` is `config-invalid`, so never write `{api|web}`. A `{{...}}`, `<...>` or `<<...>>` group lists exact values, without `*`, and groups never nest. One name may use only one of `{{...}}`, `<...>` and `<<...>>`, and `{...}` mixes with any of them. The sorted kinds compare values by character code, so uppercase letters sort before lowercase ones. One name can hold several groups: `root/repository/{A,B,C}+{A,B,C}` matches `root/repository/C+B`. Write the lines you propose to the human in this syntax.

A script name in backticks stands for the names that a script listed in the `scripts` key prints, one per line. The check runs each script once per process. When a script fails, prints nothing or prints an invalid name, the check reports `config-invalid` with its stderr. Fix a mistake you made in the script or in the file it reads, or stop and ask the human. A script that prints other values than the lock recorded is `config-changed`, so a human approves the new values with `buckets refresh`. The file a script reads decides what the lines match, like the config, so never change it to make a denied import or folder pass. Ask the human instead.

When several lines match, the most specific one decides, and `default` decides when none matches. A pattern with more literal bucket names is more specific. On a tie, more names with `*` or a group mixed in win, then more segments that are exactly `*`, then fewer `**`. Where a segment sits does not matter, so `root/**/payments` and `root/teams/**` are equally specific. Read the lines before you add a dependency between buckets, and pick a path they allow.

Under `"default": "deny"`, a parent's `_/` code that imports from a child through `.self` needs an allow line too, such as `root/billing -> root/billing/**`.

- `access-denied`: the importing bucket may not use the origin bucket. Remove the dependency and solve the task with the buckets you may use. If the task needs that dependency, stop and ask the human, with the exact line you propose, the list it goes in and why, such as: "Add `root/teams/search -> root/sql` to `access.allow`, so search can read live prices." Do not work around the rule by copying the code or routing it through another bucket.
- `access-ambiguous`: an allow line and a deny line both match, and neither is more specific than the other on both sides. Stop and ask the human to add a line that names both buckets, such as `root/teams/search -> root/sql`, in the list that should win. Quote the two lines from the message.
- `access-unknown-bucket`: a line names a bucket that does not exist, usually because a bucket folder was renamed or moved. If you renamed or moved it, move it back. Otherwise ask the human to fix the line.
- Never edit `buckets.config.json` to get past a rule, not even to fix a typo. A hook blocks it in agents with slopbuckets hooks.

## Layout

`buckets.config.json` may have a `layout` key that says which bucket folders may exist:

```json
"layout": {
  "default": "deny",
  "allow": ["root/gpu/*", "root/*/*"],
  "deny": ["root/legacy/**"]
}
```

Each line is one pattern, with the syntax of the access patterns above. The most specific matching line decides, and `default` decides when none matches. A bucket also passes when no deny line matches it and an allow line can match a bucket below it, so `root/*/*` lets `root`, `root/billing` and `root/billing/invoices` exist, but not `root/billing/invoices/pdf`. Without `layout`, any bucket folder may exist. Read the layout before you create a bucket folder.

- `layout-denied`: the layout forbids this bucket folder. If the folder only organizes code, move its contents into the `_/` of its parent bucket. Otherwise remove it, or stop and ask the human with the exact line you propose, the list it goes in and why, such as: "Add `root/billing/invoices/pdf` to `layout.allow`, so the PDF renderer gets its own bucket."
- `layout-ambiguous`: an allow line and a deny line match the folder equally. Stop and ask the human to add a line more specific than both, such as the path of the folder itself, in the list that should win. Quote the two lines from the message.

## Nested projects

A folder inside some bucket's `_/` that holds its own `buckets.config.json` is a nested project. It has its own root folder, alias, `buckets.lock.json` and rules.

- The enclosing project does not scan a nested project and never imports from it. A nested project never imports from the enclosing one either. Projects share code only through links, described below. A nested project that links the enclosing project always gets a copy, because a junction there would contain the nested project itself.
- A `buckets.config.json` anywhere else inside the root folder fails the check with `project-misplaced`. Move the project into a subfolder of a bucket's `_/`.
- To create one, run `buckets init` inside a subfolder of a bucket's `_/`. It generates a unique alias and skips the hooks and the skill, which the enclosing project already has.
- `buckets check` checks the current project and every nested one. Each violation and lock difference in `--json` has a `project` field (`.` is the project where the check ran), and `file` is relative to that project. `buckets check --no-recursive` checks only the current project.

## Sharing code between projects

A link works like a git submodule: it brings the source of another slopbuckets project into a bucket of this one, and this project compiles and runs that code with its own tools. Values and types can both cross a link.

### Publishing

A bucket publishes code to other projects with `<parent>/dmz/<bucket>/.external.ts`, which follows the DMZ syntax and may only re-export from the surface of `<bucket>`:

```ts
// root/dmz/server/.external.ts in the project with alias @root-k3x9pm2a
export { handle } from '@root-k3x9pm2a/server/_/router';
export type { AppRouter } from '@root-k3x9pm2a/server/_/router';
```

- `.external.ts` is exempt from the orphan rule, because its consumers live in other projects.
- Other projects import only these files. Everything else in the project stays private, so you may change it freely as long as the published signatures stay the same.
- The project's own lock pins each published signature like any DMZ symbol. A project that links this one has its own lock entry for them too: a changed signature, or a symbol added or removed, needs approval there as well.

### Consuming

- Every project has its own import alias, such as `@root-k3x9pm2a` (`buckets init` generates one). Two linked projects must not share an alias; `buckets link add` refuses a collision and explains how to resolve it.
- Run `buckets link add <name> <folder of the other project>` inside the bucket that needs the code (or pass `--bucket <path>`). The folder is the one that holds the other project's `buckets.config.json`. The command:
  - places the other project's root folder in `<bucket>/_/links/<name>/`, as a junction or symlink when it can (kept out of git through `.gitignore`), or as a copy (`--copy`, or when a link cannot be created) of the `.external.ts` files and every file they import, in the same paths, which you commit
  - records the link, its mode and the origin's alias in `buckets.links.json`
  - adds `"<origin alias>/*": ["./<root>/<bucket>/_/links/<name>/*"]` to `compilerOptions.paths` in `tsconfig.json`, or prints that line when it cannot edit the file safely; add it by hand then
  - adds `<root>/<bucket>/_/links/<name>` to `exclude` in `tsconfig.json`, so `tsc` compiles only the linked files your code imports and not the whole other project, or prints the line to add by hand
  - prints the alias settings for any Vite, Next or webpack config it finds. It never edits those files; add the alias there yourself.
- Import the linked project through its alias and its `.external` files only, from the bucket that owns the link:

  ```ts
  import { handle, type AppRouter } from '@root-k3x9pm2a/dmz/server/.external';
  ```

  Importing any other file of the link fails the check with `link-forbidden-import`. If you need something that is not published, the other project must add it to a `.external.ts` file, and its human approves that.
- The packages that linked files import must resolve where each tool looks for them. For a copy, both type checking and runtime look in this project: add the packages to this project's `package.json`. For a junction or symlink, they look in two places. At runtime, Node and bundlers follow the link to the other project, so run `npm install` there. For type checking, `tsc` here reads the linked files through the link path and looks in this project's `node_modules`, so install each package (or its `@types` package) here too, for example as a devDependency. `link-missing-dependency` (exit code 1) names the package and the file, and says "missing for type checking" (install it in this project) or "missing at runtime" (install it in the other project).
- Files inside a link are not checked against this project's rules (the other project checks them), and you never edit them.
- A new or removed link (`link-added`, `link-removed`) and a published symbol that changed, appeared or went away (`link-changed`) are lock differences, exit code 2. Ask for approval as for any contract change. A change inside the other project that keeps the published signatures needs no approval.
- After a clone, or when the check reports `link-missing`, run `buckets link sync`. It recreates every link in `buckets.links.json` that is missing and leaves existing copies alone.
- `link-drift` means the origin of a copy changed since the copy was made. Run `buckets link update <name>`, fix the code that breaks, then ask for approval if the check still reports a difference.
- `buckets link remove <name>` deletes a link, its entry, and its `paths` and `exclude` entries in `tsconfig.json`. Remove its imports and any bundler alias too. Until a human approves the removal, the check reports a leftover import of the removed link's alias as `import-unresolved` and says the link was removed.
- Do not create other symlinks or junctions inside the root folder, and do not edit files in `_/links/`.

## The lock and approvals

- Never write any `buckets.lock.json`, the nested ones included, under any name or path: no short names, links, wildcards or scripts that compute the name. A hook blocks it in agents with slopbuckets hooks. To read a lock, use your file reading tool (Read in Claude Code), not a shell command.
- Never create, edit, move or delete any `buckets.config.json`, the nested ones included. A human owns it, and a hook blocks it in agents with slopbuckets hooks, also for shell commands that name it. Read it with your file reading tool. When a task needs a change in it, stop and ask the human with the exact lines you need and why.
- Never run plain `buckets refresh`. Only a human runs it, in a terminal. A hook blocks it in agents with slopbuckets hooks.
- Never run `buckets update` without `--check` or `--json`. Only a human updates the CLI, in a terminal, and a hook blocks it in agents with slopbuckets hooks. `buckets update --check` and `buckets update --json` only report, so you may run them. A command may start with a line such as ``slopbuckets 1.2.0 is available (installed 1.1.0). Run `buckets update`.`` on stderr. A new CLI version makes `buckets check` stop with exit code 3 until a human approves the version change, so finish the task, then tell the human the version the notice showed.
- Run `buckets check` before you finish a task. In agents with slopbuckets hooks, a hook at the end of the turn also runs it, and a git pre-commit hook may run it too.
- A hook may hand you a check report: after an edit, when a tool call is refused, or at the end of a turn as a message that starts with `[slopbuckets]`. Treat it like the output of `buckets check`. Fix what it reports, or explain why you cannot.
- When the session is open in a folder above the projects, the end-of-turn hook checks each project you changed, and its report starts each section with the project folder. Run `buckets check` and `buckets refresh --web` in that folder.

What to do with each exit code of `buckets check`:

| Code | Meaning | What you do |
|---|---|---|
| 0 | everything passes | finish |
| 1 | a rule is broken | fix it, or explain why you cannot |
| 2 | the rules pass, but contracts changed since the last approval | ask the human to approve, as described below |
| 3 | environment problem | stop and show the human the message from the check |

### Asking for approval (exit code 2)

1. Run `buckets refresh --web` in the background, with exactly that one flag. It prints the changes and, on its last line, a link to a review page on `127.0.0.1`.
2. Send the link to the human with a short summary: which DMZ files changed, which buckets, nested projects or links were created or removed, and why you made each change. With nested projects the page has one section per project, and the human approves each one on its own.
3. Wait for the command to finish. Do not open the page or call its endpoints yourself. The human reads the page, clicks Approve and types the confirmation code shown on the page into a window of the operating system. Never ask the human for that code and never try to type it.
4. Exit code 0 means the human approved and the lock is written. Exit code 1 means the human cancelled, approved only some projects, or the page closed after 30 minutes without activity (2 hours at most). Do not retry on your own. Ask the human what to change.

If `buckets refresh --web` says it cannot ask for approval on this machine (an SSH session, a container or no desktop), ask the human to run `buckets refresh` in their own terminal. The human can always choose to approve that way instead.

If you are a subagent and the check fails because of something outside your task, say so in your final message. The orchestrator decides what to do.

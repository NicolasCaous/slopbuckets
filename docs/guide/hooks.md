---
title: Hooks
description: The loop between the agent and the config, when a hook warns and when it interrupts, the pending list, the stop, monorepos and environment errors.
---

# Hooks

The hooks compare the code with `buckets.config.json` while an agent works. They say nothing while the two agree, so a session without violations costs no tokens. When an edit makes them disagree, the hook tells the agent what diverged and how to fix it, and the agent decides.

## The loop

1. An agent edits a file. Before the edit runs, the pre-edit hook simulates it in memory and checks the result.
2. If the edit adds a violation, the hook adds the pending list to the agent context. The edit still runs.
3. The agent picks an answer. It fixes the code, or it edits `buckets.config.json` and writes the reason for the change. Both are valid.
4. The pending list shows before every later tool call until it is empty. A resolved violation shows once as `[RESOLVED]` and then disappears.
5. When the agent ends its turn with violations left, the stop hook blocks once with every violation in full.

The reason the agent writes in step 3 stays in the config. Months later, another agent reads `"log": "Logs failed charges with the invoice id"` and knows why `billing` depends on `log` without asking anyone.

## The phases

| Phase | When it runs | What it does |
|---|---|---|
| `pre-edit` | before each write, edit or patch | simulates the edit in memory and adds the pending list as context, or denies the edit when it makes the config worse |
| `pre-tool` | before every other tool call, such as a shell, a read or a search | adds the same pending list as context without simulating anything; for a shell, it also marks the session as having changed files |
| `stop` | at the end of a turn, only when the session changed files | runs the full check and blocks once with every violation in full |
| `subagent-stop` | at the end of each subagent | the same as stop, and the block reason goes to the subagent |
| `post-compact` | after a compaction | clears the memory of what the session already showed |

The agent calls `buckets hook [--agent <name>] <event>` with its own event names, and `buckets hook --agent <name> --help` lists them. The adapter of each agent maps an event to a phase. Claude Code, for example, has one `pre-tool-use` event: it runs pre-edit for `Write` and `Edit`, and pre-tool for every other tool. A `NotebookEdit` or `MultiEdit` also runs as pre-tool, because the hook cannot compute the new text, and it marks the session as having changed files.

When slopbuckets is a dev dependency of the project and you run its `buckets init`, the hooks call `node ./node_modules/slopbuckets/dist/index.js hook ...` instead of `buckets hook ...`, so they run the version the project pins and need nothing on the PATH. They never call `npx`, which adds about 900 ms to each call.

The pre hooks never answer "allow". In Claude Code, Factory Droid, GitHub Copilot and Crush, an allow answer skips the user permission prompt, and Devin probably does the same, which no live test has confirmed yet. So a warning goes out as context only, and an interrupt goes out as a deny with the reason. The stop hook blocks only once per turn: Claude Code marks the second stop with `stop_hook_active`, and agents without that flag get a mark in the session state.

Agents differ in which phases they have. An agent without context before the tool gets the warning after the edit. An agent without a stop that blocks relies on the `AGENTS.md` block, which tells it to run `buckets check` before it finishes, and on the git pre-commit hook. [Supported agents](./agents/) has the table.

## Warn or interrupt

| Rule | pre-edit and pre-tool | stop and subagent-stop |
|---|---|---|
| `config-invalid` | interrupt | interrupt |
| every other rule | warn | interrupt |

A warning lets the tool run. An interrupt denies the edit, or keeps the turn from ending. The stop has no warnings, because the turn is over and nobody would read them. [Advice](../reference/rules#advice), the notes on weak reasons and large ignore globs, never warns or interrupts on its own.

`config-invalid` interrupts in pre-edit because with an unreadable config the check cannot run, and every other warning would disappear until the stop. An edit that makes the config worse, with a problem that was not there or more of them, is denied and never reaches the disk:

```text
buckets: edit not applied, buckets.config.json would be invalid.
  buckets.billing.dependsOn.log: reason is empty
  fix config: write a one-line reason, for example "log": "<why billing needs log>"
```

An edit that removes a bucket key while a `dependsOn` still names it, and adds a new key, reads as a rename. The deny then says to rename the key and every `dependsOn` entry that names it in the same edit:

```text
buckets: edit not applied, buckets.config.json would be invalid.
  buckets.billing: removed while dependsOn still names it, and buckets.invoicing is new
  fix config: to rename billing to invoicing, rename the key and every dependsOn entry that names billing in the same edit: buckets.api.dependsOn and buckets.mail.dependsOn
```

When a shell command, a checkout or a merge already broke the config, its problems show in the pending list, and the hook denies only an edit that adds a problem. The agent can edit other files and fix the config one problem at a time.

The [rules reference](../reference/rules#warn-or-interrupt) has the matrix for every rule, generated from the contract.

## The pending list

While the list is not empty, pre-edit and pre-tool show all of it before every tool call. For an edit, the list includes the simulated effect of the edit. For other tools, it is the last known list, with the files of each violation checked again by modification time so that fixed ones drop out. Pre-tool also notices when `buckets.config.json` changed on disk, for example because another agent edited it, and checks that project again. A shell command can change any file, and checking every file before each tool call would be too slow, so after one the list says under its header: `A shell command ran since the last full check, so this list may miss problems it caused. The stop at the end of the turn checks every file.` After an edit of the config in this session, the hook keeps a hash of the text the edit wrote, so a change by another agent right after that edit shows too.

A new violation shows in full under `[NEW]` once. From then on it shows under `[OLD]` as a one-line reminder with its location. The reminder does not repeat the fix lines. A violation that went away shows once under `[RESOLVED]`:

```text
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

Every error shows in full once and then as its reminder. The list never folds several violations into a count.

When an edit of `buckets.config.json` writes a purpose or reason that gets `reason-generic` advice, the next pre-edit or pre-tool shows that advice once, after the list, under `buckets advice: 1 note on the config. Advice does not fail the check or block the turn.` It shows even when nothing is pending, so every agent that shows pre-tool context gives it to the model. Advice that the config already had when the session first saw the project does not show, and an edit that writes no such purpose or reason adds nothing. A change of the config on disk, by a shell command or another agent, shows its new advice the same way.

The memory of what was shown lives in `.buckets/sessions/<session_id>.json`, and a subagent has its own file, `<session_id>-<agent_id>.json`. A compaction erases what the model saw, so post-compact clears the memory and every pending violation shows in full again. In an agent without a compaction event, the memory is never cleared and the reminders keep going.

A violation that resolves and later comes back shows in full again.

## Monorepos

A session opened at the root of a repository can edit files of several projects. The hook finds the project of each edited file from its path: the nearest `buckets.config.json` at or above the file, inside the folder the session opened. An edit in `packages/sdk/src/client.ts` is checked against `packages/sdk/buckets.config.json`, and a violation of that project starts with `packages/sdk: `. The stop checks every project the session touched.

Agents read their hook settings from the folder the session opens, so hooks installed only in `packages/sdk/` do not run in a session opened at the root. `buckets init` warns when it runs below the top of the git repository, and `buckets init --root` also installs the agent hooks at the top folder. See [Nested projects](./nested-projects).

## Environment errors

An environment error means a project could not be checked at all, for example because it has no `tsconfig.json`. The [rules reference](../reference/rules#environment-codes) lists the codes. The pre hooks show each environment error once per session as context, and the stop blocks once with it.

`config-newer` is the exception at the stop. It means the config declares a newer `version` than the installed slopbuckets reads, so the fix is a newer CLI, which is the human's call. The hooks show its message once, as context, and never deny an edit or block a stop because of it:

```text
buckets: cannot check (config-newer): buckets.config.json has version "2.1", which needs slopbuckets 2.1 or later, and this is slopbuckets 2.0.0. Run buckets update, then run buckets check again.
```

## What the hooks read

To get the new text of an edit, a hook applies the edit to the file on disk, and it reads files only inside the project. It never reads a file outside the project, a link, a pipe or a device, or a file over 4 MB. For such a file the new text stays unknown, so the hook shows the current pending list and marks the session as one that changed files. An edit outside the project is not checked.

The check keeps its cache in `.buckets/`. Each cache file carries a random key that lives in the git folder of the clone, which no commit carries. A cache that arrives in a commit or a pull request has another key, so the check ignores it and rebuilds it.

## The stop

```text
buckets: 2 structure violations remain. Fix the code or edit buckets.config.json. Either is valid.

billing -> log: undeclared dependency
  src/billing/invoice.ts:3 imports logError from src/log/index.ts
  billing: Issues and charges invoices
  log: Formats and writes application logs
  choose one fix:
  fix code: remove the import by moving the code that needs it into log, or by moving what it uses from log into billing
  fix config: add "log": "<one-line reason>" to buckets.billing.dependsOn

src/utils/date.ts: in no bucket and not ignored
  choose one fix:
  fix code: move the file into a folder that a bucket owns
  fix config: add it to a bucket's files, or to ignore if it is not product code, such as a test, a script or a generated file
```

The stop runs only when the session changed files, with an edit or a shell command, which can change any file, or still has pending violations. A turn that only read code ends without a check.

When the check also finds advice, the block lists it after the violations, under `buckets advice: 1 note on the config. Advice does not fail the check or block the turn.` Advice alone never blocks. When the turn ends with no violation but the session wrote a purpose or reason that gets `reason-generic` advice, the stop shows that advice once, under the same heading, and lets the turn end. It does so even when a pre-tool already showed the advice to the model. Claude Code shows it to you as a system message. The other agents have no place for text at the end of a turn that does not continue it, so they print nothing. The model still got the advice from the pre-tool after the edit, and `buckets check` lists it.

When every violation of the block was also left at the end of an earlier turn, the block ends with:

```text
These were also left at the end of an earlier turn. If you leave them, tell the user which ones and why.
```

So an agent that keeps violations on purpose says so to the user instead of leaving them without a word.

## Why both fixes are valid

The hook is neutral. It never says that the code is wrong and the config is right, or the other way round. An undeclared import can be a mistake, or the first sign that `billing` needs `log`. The agent that wrote the import has the context to tell. If it keeps the import, it declares the dependency and writes why. If it removes the import, the config stays as it was.

What the hook asks for is that the two agree, and that every decision has a reason in the file. That is what lets the next agent inherit the architecture instead of guessing it.

## Every message

Every full message ends with what to do. When both answers make sense, it shows `choose one fix:`, then `fix code:` and `fix config:`. The two fix lines are alternatives, and the agent picks one. When only one answer makes sense, as with a computed `import()` path, it shows only that one. Each fix names the exact files, buckets and config keys, so the agent can act without opening anything.

The [rules reference](../reference/rules) has every variant of every message and its one-line reminder, generated from the message renderer, and the [hooks reference](../reference/hooks) has the pending list, the stop and the deny in their exact form.

<h1 align="center">
  <a href="https://nicolascaous.github.io/slopbuckets/"><img src="https://raw.githubusercontent.com/NicolasCaous/slopbuckets/main/.github/readme/hero.svg" width="1280" alt="slopbuckets. Let the AI write slop. Keep it in buckets."></a>
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/slopbuckets"><img src="https://img.shields.io/npm/v/slopbuckets?style=flat-square&label=npm&labelColor=021a0a&color=3dff74" alt="npm version"></a>
  <a href="https://github.com/NicolasCaous/slopbuckets/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/NicolasCaous/slopbuckets/ci.yml?branch=main&style=flat-square&label=ci&labelColor=021a0a" alt="CI status"></a>
  <a href="https://github.com/NicolasCaous/slopbuckets/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/slopbuckets?style=flat-square&label=license&labelColor=021a0a&color=3dff74" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/slopbuckets"><img src="https://img.shields.io/node/v/slopbuckets?style=flat-square&label=node&labelColor=021a0a&color=3dff74" alt="Node.js version"></a>
</p>

<p align="center">
  <a href="https://nicolascaous.github.io/slopbuckets/"><b>Website</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://nicolascaous.github.io/slopbuckets/docs/"><b>Docs</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://nicolascaous.github.io/slopbuckets/docs/guide/getting-started.html"><b>Getting started</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://www.npmjs.com/package/slopbuckets"><b>npm</b></a>
</p>

slopbuckets splits a project into sealed folders called buckets. Inside a bucket, the AI writes whatever it wants. Between buckets, every import goes through a contract file in a `dmz/` folder, and a human approves every change to those contracts.

```sh
npm install -g slopbuckets
```

## Why

An AI agent solves each task by the shortest path, and the shortest path is usually an import from some other part of the project. After a few hundred tasks, every module depends on every other module.

Code review does not catch this, because each import looks reasonable on its own. slopbuckets moves the boundaries out of review and into a check that fails the build. A human owns the dependency graph. The AI owns the code inside each node.

Because the contracts are fixed, the code inside a bucket is disposable. If a bucket turns into a mess, you can delete its code and have the AI rewrite it from the contracts.

Here an agent imported the logger from another bucket instead of going through the DMZ. `buckets check` stops it, and the report tells the agent how to fix it:

<p align="center">
  <img src="https://raw.githubusercontent.com/NicolasCaous/slopbuckets/main/.github/readme/check-fail.svg" width="792" alt="Terminal output of buckets check, exit code 1. In root/billing/invoices/_/create-invoice.ts, line 1 breaks import-forbidden because it imports root/log/_/logger.ts directly, and line 2 breaks import-relative. The logger contract in the DMZ is now unused, so the check also reports a dmz-orphan chain. The summary reads 4 violations in 3 files.">
</p>

## How it works

### Buckets

The root of the project is a bucket called `root`. Each bucket contains only three kinds of things:

- `_/`, the bucket's own code, where the AI can create any files and folders
- `dmz/`, the contracts between its children, present when the bucket has children
- child buckets

```
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

The tree is two levels deep by default. You can change the limit in the config.

### DMZ

Inside `P/dmz/`, the folder is the provider and the file is the consumer. `dmz/sql/http.ts` lists everything `http` takes from `sql`. Two names are reserved:

- `.self` is the bucket's own code in `P/_/`
- `.parent` is what `P` receives from the level above

| File in `billing/dmz/` | Meaning |
|---|---|
| `payments/invoices.ts` | what `invoices` takes from `payments` |
| `.self/invoices.ts` | what `invoices` takes from `billing/_` |
| `invoices/.self.ts` | what `billing/_` takes from `invoices` |
| `.parent/invoices.ts` | what `invoices` takes from outside `billing` |
| `invoices/.parent.ts` | what `invoices` exposes outside `billing` |

A DMZ file can only re-export named symbols. Every internal import goes through the project's alias, which `buckets init` generates as `@<root folder>-<8 characters>`. Here the alias is `@root-k3x9pm2a`, and `invoices` gets the logger from `log`:

```ts
// root/dmz/log/billing.ts
export { logger } from '@root-k3x9pm2a/log/_/logger';

// root/billing/dmz/.parent/invoices.ts
export { logger } from '@root-k3x9pm2a/dmz/log/billing';

// root/billing/invoices/_/create-invoice.ts
import { logger } from '@root-k3x9pm2a/billing/dmz/.parent/invoices';
```

Each hop is one file. To find out what a bucket uses, open its DMZ files. The [concepts guide](https://nicolascaous.github.io/slopbuckets/docs/guide/concepts.html) walks through every case.

### Lock

`buckets.lock.json` records the last state a human approved: the bucket tree, the config, every DMZ file, the type signature of every symbol a DMZ file exports, the nested projects, and each link with the signatures of the symbols the linked project publishes. If the AI changes the signature of an exported function without touching any DMZ file, the signature hash changes and the check fails.

Here the agent added a parameter to `createInvoice` and a new DMZ file. Every rule passes, so the check exits with 2 and waits for a human:

<p align="center">
  <img src="https://raw.githubusercontent.com/NicolasCaous/slopbuckets/main/.github/readme/check-lock.svg" width="792" alt="Terminal output of buckets check, exit code 2. Under Lock differences it lists dmz-added for root/billing/dmz/.parent/payments.ts and signature-changed for createInvoice in root/billing/dmz/invoices/.self.ts. The summary reads 2 lock differences and tells the agent to run buckets refresh --web in the background and send the link to the human.">
</p>

Every kind of lock difference is listed in the [lock reference](https://nicolascaous.github.io/slopbuckets/docs/reference/lock.html).

## Commands

Each command below runs as `buckets <command>`.

| Command | Who runs it | What it does |
|---|---|---|
| `init [--yes]` | a human, once per project | writes the config with a unique alias, `root/_/`, the alias in `tsconfig.json`, the hooks of your coding agent, the rules in `AGENTS.md` and the skill. It never writes the lock |
| `init --agent <names>` | a human | installs the hooks of these agents instead of Claude Code, such as `--agent codex,cursor`, or `--agent auto` for every agent whose folder is in the project |
| `init --git-hook` | a human | also installs a git pre-commit hook that runs `buckets check` |
| `check` | the AI, the hooks and CI | checks every rule and compares the project with the lock, in this project and every nested one |
| `check --json` | scripts and CI | prints the same check as a JSON report |
| `check --file <path>` | the agent hook after an edit | checks one file, cycles included, without the orphan rule and the lock |
| `refresh` | a human, in a terminal | shows every change since the last approval, asks for confirmation and writes the lock, project by project |
| `refresh --web` | the AI, in the background | serves the same review on `127.0.0.1` and writes the lock after a human types the page's code in a window of the operating system |
| `inspect` | anyone | serves a read-only page with the map, the DMZ matrix and the pending approvals, updated while files change |
| `inspect --json` | the AI | prints the same state as JSON and exits |
| `inspect --export svg\|mermaid\|html` | anyone | prints the map as SVG, the bucket graph as a Mermaid flowchart or the whole page as one HTML file. `--out <file>` writes a file |
| `link add <name> <folder>` | the AI | links the source of another project into `<bucket>/_/links/<name>/`, as a junction or symlink to its root folder, or with `--copy` as a copy of the files its `.external.ts` files reach. It adds the project's alias to `tsconfig.json` and prints the settings for a bundler |
| `link sync` | anyone, after a clone and in CI | recreates every link in `buckets.links.json` that is missing |
| `link update [name]` | the AI | copies the origin of links in copy mode again |
| `link remove <name>` | the AI | deletes a link, its entry in `buckets.links.json` and its entries in `tsconfig.json` |
| `hook <event>` | Claude Code | runs a hook: `pre-tool-use`, `post-tool-use`, `stop` or `subagent-stop` |
| `hook --agent <name> <event>` | another agent | runs a hook of that agent, reading and writing its own JSON format |

`buckets check --no-recursive` skips the nested projects. Every option and message is in the [CLI reference](https://nicolascaous.github.io/slopbuckets/docs/reference/cli.html).

## Approving a change

The AI can edit any file, DMZ files included. It cannot edit the lock. When the AI changes a contract, `buckets check` exits with 2 until a human approves the change. In an agent session the approval goes through `buckets refresh --web`:

1. The agent runs `buckets refresh --web` in the background, and may redirect its output to a log file. The command refuses to start while a rule is broken. It prints the changes and, on its last line, a link to a page on `127.0.0.1`.
2. The agent sends the link to the human with a summary of what changed and why, and waits for the command to finish.
3. The page lists the changes to buckets, DMZ files, symbols, signatures, nested projects, links, the config and the versions, and shows a 6-character confirmation code for that state.
4. The human clicks Approve. A window of the operating system lists the same changes and asks for the code. The lock is written only if the typed code matches the state of the project at that moment.

<p align="center">
  <img src="https://raw.githubusercontent.com/NicolasCaous/slopbuckets/main/.github/readme/refresh-web.svg" width="1280" alt="The review page of buckets refresh --web in a green CRT monitor. It lists 2 contract changes of the project acme and shows a 6-character confirmation code. In front of it, the confirmation window of the operating system lists the same two DMZ changes, and the human has typed the same code before clicking Approve.">
</p>

The agent has the link, but it cannot type into that window. If the project changes after the page loaded, the page still shows the old code and the approval fails. With nested projects, the page has one section per project and each one is approved on its own.

`buckets refresh --web` exits with 0 after an approval or when nothing waits for one, and with 1 after a cancel, a partial approval, 30 minutes without activity on the page or 2 hours in all. Over SSH, in a container or on a machine without a desktop it refuses at the start, and the human runs `buckets refresh` in a terminal instead. A human can always approve that way. More in [The approval flow](https://nicolascaous.github.io/slopbuckets/docs/guide/approval.html) and [Who runs which command](https://nicolascaous.github.io/slopbuckets/docs/guide/commands.html).

### Exit codes

`buckets check` exits with:

| Code | Meaning | What the AI does |
|---|---|---|
| 0 | everything passes | continues |
| 1 | a rule is broken | fixes it |
| 2 | the rules pass, but the project differs from the lock | runs `buckets refresh --web` and sends the link to a human |
| 3 | environment problem, such as a CLI version that differs from the lock | stops and tells the human |

With nested projects, the check exits with the most serious code of any project, in the order 3, 1, 2, 0. A broken rule together with a lock difference gives 1, because the AI fixes the rule before it asks for approval.

## What the check enforces

Folders:

- A bucket holds only `_/`, `dmz/` and child buckets, within `maxDepth`. Every bucket has a `_/`, a bucket without children has no `dmz/`, and a bucket name cannot start with `.`.
- Symlinks and junctions inside the root folder fail. The only exception is a link registered with `buckets link add`.
- A new bucket folder needs human approval, like any contract change.

DMZ files:

- A DMZ file sits at `dmz/<provider>/<consumer>.ts`, where both names exist.
- It contains only `export { name } from` and `export type { Name } from` statements. Renames, `export *`, default exports, imports and local declarations fail.
- Each re-export points only where that DMZ file may reach, one level per file, and never into a nested project.
- Every DMZ symbol is used by some `_/` code. Importing it without referencing it does not count, and neither does re-exporting it from `_/` unless another file of the same bucket imports it from there and references it. When a chain of re-exports ends unused, the check reports the whole chain in one run. An empty DMZ file fails too.

Imports:

- Every internal import uses the project's alias. Relative imports fail.
- Code in `X/_/` imports only from `X/_/`, from DMZ files where `X` is the consumer, from packages in `package.json` and from Node built-ins. An import that resolves to nothing fails.
- Code reaches a linked project only through its `.external` files. An import of any other file of the link fails.
- `import()`, `require()`, `createRequire`, `import.meta.glob` and `import * as` from a DMZ file fail. `vi.mock`, `jest.mock` and `new URL('...', import.meta.url)` follow the same rules as an import of their string.
- Code cannot be shared without imports. Files that are not modules, `declare global`, `export as namespace` and `/// <reference>` fail. `declare module '<alias>/...'` counts as an import of that file. Ambient declaration files such as `vite-env.d.ts` belong outside the root folder.
- JavaScript files in `_/` are checked like TypeScript files.

Graph and project:

- The bucket graph has no cycles. Circular imports inside a single bucket are allowed.
- `noUnusedLocals` stays on and the alias stays in `tsconfig.json`, so an unused import cannot count as a use.
- Every project has its own `tsconfig.json`, which covers its root folder and leaves its nested projects out.
- A `buckets.config.json` inside the root folder lives only in a subfolder of a bucket's `_/`, and its alias differs from the alias of every enclosing project.
- Every link in `buckets.links.json` is on disk. Every package the linked files import resolves for type checking in this project and, for a junction or symlink, at runtime in the linked project.
- The project matches the lock. Changed contracts, signatures, buckets, nested projects, links or config give exit code 2.

Every rule id, with what it means and how to fix it, is in the [rules reference](https://nicolascaous.github.io/slopbuckets/docs/reference/rules.html).

## Inspect

`buckets inspect` serves a read-only page on `127.0.0.1` with the state of the project. It never writes to the project and never approves anything, so the AI may run it at any time. The page has these views:

- a map of the buckets as nested boxes, green when they pass, amber when they differ from the lock and red when they break a rule
- a DMZ matrix per level, with the symbols and signatures of each contract
- a symbol trace from the origin through every re-export to each file that imports it
- a panel per bucket with what it offers and consumes, who depends on it and its rewrite cost
- the nested projects and their links, the pending approvals and a live feed of events
- a timeline of approvals read from the git history of `buckets.lock.json`, and an impact view that shows which contracts break if a bucket goes away

<p align="center">
  <img src="https://raw.githubusercontent.com/NicolasCaous/slopbuckets/main/.github/readme/inspect.svg" width="1280" alt="The read-only buckets inspect page in a green CRT monitor. The map draws the buckets of the project acme as nested boxes: root, billing with invoices and payments, and log. billing is amber because its contracts differ from the lock, and payments holds the nested project payment-gateway. A side panel counts the buckets, contracts, symbols and violations and links to 2 differences to approve.">
</p>

Try the [live demo](https://nicolascaous.github.io/slopbuckets/demo/), the page of a generated project with about 300 buckets, exported with `buckets inspect --export html`.

`buckets inspect --json` prints the same state for an agent: buckets with what they offer and consume, contracts with the origin, chain, signature and importers of each symbol, violations and lock differences. `buckets inspect --export svg` and `--export mermaid` print the map and the bucket graph without a server, and `--export html` prints the whole page as one file that works offline. See the [inspect guide](https://nicolascaous.github.io/slopbuckets/docs/guide/inspect.html) and the [snapshot reference](https://nicolascaous.github.io/slopbuckets/docs/reference/inspect.html).

## Projects and links

A folder inside a bucket's `_/` that has its own `buckets.config.json` is a nested project, with its own root folder, alias, lock, rules and `tsconfig.json`. Run `buckets init` in that folder to create one. It adds the folder to `exclude` in the `tsconfig.json` of the enclosing project, which does not scan or compile the nested one. `buckets check` checks the current project and every nested one, each against its own lock.

Projects share code through links. A link works like a git submodule: it brings the source of another project into a bucket, and the consuming project compiles and runs that code with its own tools. Values and types both cross a link.

The project `api`, with the alias `@root-h4vq8sne`, publishes what other projects may import in `<parent>/dmz/<bucket>/.external.ts`, with the same syntax as any DMZ file:

```ts
// api/root/dmz/server/.external.ts
export { handle } from '@root-h4vq8sne/server/_/router';
export type { AppRouter } from '@root-h4vq8sne/server/_/router';
```

The project `web` links `api` into its bucket `frontend`:

```sh
cd web/root/frontend
buckets link add api ../../../api
```

The command places the root folder of `api` in `root/frontend/_/links/api/`, as a junction or symlink kept out of git. With `--copy`, it copies the `.external.ts` files of `api` and every file they import, and you commit the copy. The command also:

- records the link in `buckets.links.json`
- maps `@root-h4vq8sne/*` to the link folder in `compilerOptions.paths` of `tsconfig.json`
- adds the link folder to `exclude`, so that `tsc` compiles only the linked files the code imports
- prints the alias settings for any Vite, Next or webpack config it finds, without editing that config

Code in `frontend` then imports `api` through its alias and its `.external` files:

```ts
// web/root/frontend/_/client.ts
import { handle, type AppRouter } from '@root-h4vq8sne/dmz/server/.external';
```

Each project needs its own alias, and `buckets link add` refuses two linked projects with the same one. The packages the linked files import must resolve where each tool looks for them. `tsc` looks in the consuming project. With a junction or symlink, Node and bundlers follow the link and load the packages from the linked project at runtime, so install them in both projects. With a copy, both look in the consuming project.

A new or removed link, and a published symbol that was added, removed or changed its signature, are lock differences that the consuming project's human approves. A change inside `api` that keeps the published signatures needs no approval. After a clone, `buckets link sync` recreates the links that git does not hold. More in [Projects and links](https://nicolascaous.github.io/slopbuckets/docs/guide/projects-and-links.html) and the [links registry reference](https://nicolascaous.github.io/slopbuckets/docs/reference/links.html).

## Works with your agent

`buckets init` sets up Claude Code by default. Pass `--agent <name>` for another agent, a list such as `--agent codex,cursor` for several, or `--agent auto` for every agent whose folder is already in the project:

```sh
buckets init --agent auto
```

Every agent also gets the rules in a block of `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`. On top of that, the hooks of each agent enforce up to three things: the lock guard refuses a write to the lock and a plain `buckets refresh`, edit feedback hands the `buckets check --file` report to the model after each edit, and the turn check blocks the end of a turn while `buckets check` fails.

| Agent | `--agent` | Lock guard | Edit feedback | Turn check |
|---|---|---|---|---|
| [Claude Code](https://nicolascaous.github.io/slopbuckets/docs/guide/claude-code.html) | `claude` | yes | yes | yes |
| [Codex CLI](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/codex.html) | `codex` | yes | yes | yes |
| [Cursor](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/cursor.html) | `cursor` | yes | partial | yes |
| [Gemini CLI](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/gemini.html) | `gemini` | yes | yes | yes |
| [GitHub Copilot](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/copilot.html) | `copilot` | yes | yes | yes |
| [Factory Droid](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/factory.html) | `factory` | yes | yes | yes |
| [Qwen Code](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/qwen.html) | `qwen` | yes | yes | yes |
| [Auggie](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/auggie.html) | `auggie` | yes | yes | yes |
| [Devin Desktop](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/devin.html) | `devin` | yes | partial | yes |
| [OpenCode](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/opencode.html) | `opencode` | yes | yes | partial |
| [Pi](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/pi.html) | `pi` | yes | yes | yes |
| [Amp](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/amp.html) | `amp` | yes | yes | yes |
| [Cline](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/cline.html) | `cline` | partial | yes | no |
| [Windsurf](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/windsurf.html) | `windsurf` | yes | no | no |
| [Kiro](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/kiro.html) | `kiro` | partial | no | no |
| [Goose](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/goose.html) | `goose` | yes | no | yes |
| [Crush](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/crush.html) | `crush` | yes | no | no |
| [Zed](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/zed.html) | `zed` | partial | no | no |
| [Aider](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/aider.html) | `aider` | no | partial | no |
| [Continue](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/continue.html) | `continue` | no | no | no |

Every hook fails open. On a machine without the `buckets` command, the agent's calls go through and no check runs. `buckets init --git-hook` and `buckets check` in CI hold the rules for every agent, and for an agent that is not in the list. The [supported agents page](https://nicolascaous.github.io/slopbuckets/docs/guide/agents/) explains each partial and links to a page per agent.

### Claude Code

`buckets init` installs a skill that teaches the agent the rules, and four hooks:

| Hook | What it does |
|---|---|
| `PreToolUse` | denies writes to any `buckets.lock.json`, shell commands that name the lock and any `buckets refresh` without exactly the `--web` flag, even in bypass permission mode. It allows `buckets refresh --web` in the background with its output redirected, piped to `tee` or under `nohup`, unless the redirect writes to the lock |
| `Stop` | runs `buckets check` on every project before the agent ends its turn |
| `SubagentStop` | runs `buckets check` before a subagent hands back its work |
| `PostToolUse` | checks each edited file and reports a forbidden import right away |

When the check exits with 2, the skill tells the agent to run `buckets refresh --web` in the background, send the link with a summary, and wait. A nested `buckets init` skips the hooks and the skill, because the enclosing project's hooks cover it. In a session opened in a folder above several projects, with the hooks in that folder's or your user settings, each hook works on the project of the file or command, and `Stop` checks only the projects the session touched. See the [Claude Code guide](https://nicolascaous.github.io/slopbuckets/docs/guide/claude-code.html) for the details of each hook.

## Install

```sh
npm install -g slopbuckets
cd your-project
buckets init       # config, root/_/, tsconfig alias, agent hooks, AGENTS.md and skill
buckets refresh    # you approve the initial state and create buckets.lock.json
```

To let a coding agent do the setup, paste "Install slopbuckets in this project. Read https://nicolascaous.github.io/slopbuckets/llms.txt and follow the steps for agents." The agent follows [llms.txt](https://nicolascaous.github.io/slopbuckets/llms.txt) and asks you to approve the first lock.

`buckets init` sets up Claude Code unless you pass `--agent`, as [Works with your agent](#works-with-your-agent) shows. It edits the `tsconfig.json` of the project folder, so create one first. A nested project needs its own too. `buckets init` also generates a unique alias such as `@root-k3x9pm2a`, so that projects that link each other never share one. It asks before it uses it, and `--yes` takes it as is.

`buckets init` never writes the lock. Only a human approves a state, with `buckets refresh` in an interactive terminal or in the confirmation window that `buckets refresh --web` opens.

Once a human has approved the state, `buckets check` passes:

<p align="center">
  <img src="https://raw.githubusercontent.com/NicolasCaous/slopbuckets/main/.github/readme/check-pass.svg" width="792" alt="Terminal output of buckets check, exit code 0: All bucket rules pass and the state matches buckets.lock.json.">
</p>

The CLI is a global install because it is meant to support more languages than TypeScript. Each project pins the CLI version in its lock, and `buckets check` refuses to run with a different version.

## CI

Install the CLI version the lock asks for. When the project uses links, run `buckets link sync` before the build. A link made as a junction or symlink is not in git, and the build compiles the linked source. For such a link, the linked project also needs its dependencies installed, because Node and bundlers load its packages from there:

```sh
npm ci
npx slopbuckets@$(node -p "require('./buckets.lock.json').cli") link sync    # only with links
npm run build
npx slopbuckets@$(node -p "require('./buckets.lock.json').cli") check
```

`link sync` cannot recreate a link to a project outside the repository, so use `--copy` for those. The [CI guide](https://nicolascaous.github.io/slopbuckets/docs/guide/ci.html) has a GitHub Actions workflow, and the [report reference](https://nicolascaous.github.io/slopbuckets/docs/reference/report.html) describes the JSON output.

## Config

```json
{
  "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v1.json",
  "adapter": "ts",
  "root": "root",
  "alias": "@root-k3x9pm2a",
  "maxDepth": 2
}
```

| Field | Default | Meaning |
|---|---|---|
| `adapter` | `"ts"` | language adapter the CLI uses to read the project |
| `root` | `"root"` | folder of the root bucket |
| `alias` | `"@root"` | import prefix for internal imports. `buckets init` writes a unique one. A nested project and each linked project need an alias of their own |
| `maxDepth` | `2` | maximum depth of the bucket tree |

Links live in a separate file, `buckets.links.json`, which the `buckets link` commands write. See the [config reference](https://nicolascaous.github.io/slopbuckets/docs/reference/config.html).

## Languages

The CLI applies every rule that does not depend on a language: folders, the bucket graph, cycles, orphans, nested projects, links and the lock. A language adapter reads the source code and reports exports, imports, type signatures, and the published symbols and package imports of each linked project back to the CLI as JSON. The TypeScript adapter ships with the CLI. Other languages can be added as separate adapters, following the [adapter guide](https://nicolascaous.github.io/slopbuckets/docs/guide/adapters.html).

## Threat model

slopbuckets protects against an agent that takes shortcuts, not against one that sets out to break the rules. The lock hook compares text, so a determined agent could write the lock from a script that never names it, and on Windows any process on the same desktop can type into the confirmation window. Review the lock diff in pull requests, and read the [threat model](https://nicolascaous.github.io/slopbuckets/docs/guide/threat-model.html) for the details.

## Repository layout

```
cli/             the buckets command, published to npm as slopbuckets
adapters/ts/     TypeScript adapter, bundled into the CLI
examples/        end-to-end cases that run the built CLI, one per rule
skill/           the skill buckets init installs
docs/            documentation site (VitePress), built into site/docs/
site/            website and config schema, served by GitHub Pages
scripts/         readme-assets.mjs, which draws the images in .github/readme/
```

## Development

```sh
npm ci
npm run build
npm test                 # unit tests
npm run test:examples    # builds the CLI and runs every case in examples/
npm run typecheck
npm run docs:dev         # serves the docs site locally
npm run docs:build       # builds the docs into site/docs/
npm run readme:assets    # redraws the README images from the real CLI output
```

`npm run readme:assets` takes the screenshots of `buckets inspect` and `buckets refresh --web` with a local Chrome or Edge. Set `CHROME_PATH` if it is not in the usual place. Without one, the script redraws the other images and keeps the screenshots.

## License

[MIT](https://github.com/NicolasCaous/slopbuckets/blob/main/LICENSE)

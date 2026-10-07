---
title: Install with an AI agent
description: Paste one prompt into a coding agent. It installs the CLI, sets up the project and asks you to approve the first lock.
---

# Install with an AI agent

A coding agent, such as Claude Code, Codex CLI or Cursor, can do the setup from [Getting started](./getting-started) for you. Open the agent in the project folder and paste this prompt:

<div class="agent-prompt">

```text
Install slopbuckets in this project. Read https://nicolascaous.github.io/slopbuckets/llms.txt and follow the steps for agents.
```

</div>

[llms.txt](https://nicolascaous.github.io/slopbuckets/llms.txt) is a plain text file in the [llms.txt format](https://llmstxt.org/). It holds the install steps for agents, the rules an agent must never break, and links to a Markdown version of every docs page. [llms-full.txt](https://nicolascaous.github.io/slopbuckets/llms-full.txt) has every docs page in one file. Each page of these docs also has its Markdown version at the same address with `.md` in place of `.html`.

## What the agent does

1. Checks that Node.js is version 20 or newer, installs the CLI with `npm install -g slopbuckets` and runs `buckets --version`.
2. Checks that the project has a `tsconfig.json` and the `typescript` package. When `typescript` is missing, it installs it as a dev dependency. When `tsconfig.json` is missing, it creates one with `npx tsc --init` and tells you.
3. Runs `buckets init --yes --agent <name>` with its own name, such as `claude` or `codex`, or `--agent auto` when it is not one of the [supported agents](./agents/). `--yes` keeps the defaults: the root bucket folder `root`, a generated alias such as `@root-k3x9pm2a` and a maximum depth of 2. `init` writes `buckets.config.json`, creates `root/_/`, adds the alias and `noUnusedLocals` to `tsconfig.json`, installs the hooks of that agent, writes the rules in a block of `AGENTS.md` and copies the skill.
4. Shows you what `init` changed: its output, and the diff of `tsconfig.json` and of the agent's files, such as `.claude/settings.json`. Some agents run project hooks only after you approve them in the agent, and the agent tells you when `init` asks for that.
5. Runs `buckets refresh --web` in the background and sends you the link it prints.
6. Waits for you to approve, then runs `buckets check` and tells you which files to commit: `buckets.lock.json`, `buckets.config.json`, `tsconfig.json`, `AGENTS.md`, `.agents/` and the files `init` wrote for the agent, such as `.claude/`.

## What it asks you

- To approve the first state. Open the link, read the state on the review page, click Approve, and type the confirmation code from the page into the window that your operating system opens. The agent never asks you for the code and never types it. [The approval flow](./approval) shows the page and the window.
- To run `buckets refresh` in your own terminal, when `buckets refresh --web` cannot open a confirmation window on this machine, such as in an SSH session or a container. You can also pick the terminal yourself. Answer `y` to write `buckets.lock.json`.
- To install the CLI yourself, when `npm install -g` fails because of permissions. The agent does not use `sudo`.
- What to do next, when you cancel on the review page or the page closes after 30 minutes without activity. The agent does not retry on its own.

## What the agent never does

The agent never writes any `buckets.lock.json`, never edits `buckets.config.json` itself (only `init` writes it), never runs plain `buckets refresh` and never types the confirmation code. llms.txt tells it so, and so does the skill that `buckets init` installs. In an agent with hooks, such as Claude Code, the hook that runs before each tool call denies a write to the lock or the config and any `buckets refresh` other than exactly `buckets refresh --web`. [Supported agents](./agents/) shows which agents have that hook. The [threat model](./threat-model) says what these layers stop and what they do not.

To do the same setup by hand, follow [Getting started](./getting-started).

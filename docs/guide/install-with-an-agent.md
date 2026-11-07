---
title: Install with an AI agent
description: Paste one prompt into a coding agent. It installs the CLI, sets up the project and builds the first architecture in buckets.config.json.
---

# Install with an AI agent

A coding agent, such as Claude Code, Codex CLI or Cursor, can do everything in [Getting started](./getting-started) and then write the first architecture of the project. Open the agent in the project folder and paste this prompt:

<div class="agent-prompt">

```text
Install slopbuckets in this project and build its first architecture. Read https://nicolascaous.github.io/slopbuckets/llms.txt and follow the steps for agents.
```

</div>

[llms.txt](https://nicolascaous.github.io/slopbuckets/llms.txt) is a plain text file in the [llms.txt format](https://llmstxt.org/). It holds the steps for agents, what to avoid when building the architecture, and links to a Markdown version of every docs page. [llms-full.txt](https://nicolascaous.github.io/slopbuckets/llms-full.txt) has every docs page in one file. Each page of these docs also has its Markdown version at the same address with `.md` in place of `.html`.

## What the agent does

1. Checks that Node.js is version 20 or newer, installs the CLI with `npm install -g slopbuckets` and runs `buckets --version`. When the project has slopbuckets in `node_modules`, or `buckets --version` already works, it skips the install, and with a project copy it runs each command as `npx buckets`.
2. Checks that the project has a `tsconfig.json`. When it is missing, the agent creates one with `npx -p typescript@6 tsc --init` and tells you. The project does not need the `typescript` package.
3. Runs `buckets init --agent <name>`, unless `buckets.config.json` already exists, with its own name, such as `claude` or `codex`, or `--agent auto` when it is not one of the [supported agents](./agents/), which sets up the agents whose folders or files exist and always writes the `AGENTS.md` block. `init` writes an empty `buckets.config.json` with `"version": "2.0"`, installs the hooks of that agent, writes the block in `AGENTS.md`, copies the skill, sets up the merge driver of the config and adds `.buckets/` to `.gitignore`.
4. Reads the skill, which says how to split a project into buckets, how to write a purpose and a reason, and how to translate an Nx, eslint-plugin-boundaries, Sheriff or dependency-cruiser setup.
5. Runs `buckets check`, which reports that the config has no buckets yet and lists the folders. It reads the code and writes the buckets: a purpose, the `files` globs, the public files, the dependencies and the external packages with their reasons. Tests, scripts and tool configs go in `ignore`. Where a bucket has no file that only re-exports its interface, the agent creates one, and `buckets fix import-private` points the existing imports at it. It runs `buckets check` after each change until it exits with 0.
6. Shows you the config with a short summary of the buckets and their dependencies, and tells you which files to commit.

## What it asks you

- To install the CLI yourself, when `npm install -g` fails because of permissions. The agent does not use `sudo`.
- To approve the hooks in the agent, for agents that run project hooks only after you approve them, such as Codex CLI. `init` prints that step, and the agent passes it on.
- To read the result. The agent decides the architecture on its own, but you know the project. If a bucket is too big, or a dependency reason is wrong, say so, and the agent edits the config.

## What to look for in the result

The check passes for some shapes that describe nothing:

- one bucket with `src/**`, which passes every rule
- a `utils` or `shared` bucket that every other bucket depends on
- a long `ignore` list that holds code which belongs to a bucket, which `buckets check` flags with `ignore-large` advice when one glob covers more than 20% of the source files besides tests, scripts, fixtures and examples
- reasons that repeat the bucket name, such as `"log": "Uses log"`, which get `reason-generic` advice

Ask the agent to split or rewrite these. A reason that starts with `debt:` marks a dependency the agent kept on purpose, with what is wrong and how it goes away. [What the check guarantees](./guarantees) says what a passing check means.

To do the same setup by hand, follow [Getting started](./getting-started).

---
title: Documentation
description: How slopbuckets splits a project into sealed buckets, and the reference for the buckets CLI.
---

# slopbuckets documentation

slopbuckets splits a project into sealed folders called buckets. Inside a bucket, the AI writes whatever it wants. Between buckets, every import goes through a contract file in a `dmz/` folder, and a human approves every change to those contracts.

The CLI is called `buckets`. It enforces the rules for TypeScript projects.

```sh
npm install -g slopbuckets
cd your-project
buckets init       # config, root/_/, tsconfig alias, agent hooks, AGENTS.md and skill
buckets refresh    # you approve the initial state and create buckets.lock.json
buckets inspect    # a read-only page with the map of buckets and contracts
```

## Guide

| Page | What it covers |
|---|---|
| [Getting started](./guide/getting-started) | Install the CLI, set up a project, approve the first state |
| [Install with an AI agent](./guide/install-with-an-agent) | The prompt that lets a coding agent do the setup, and what it asks you |
| [Concepts](./guide/concepts) | Buckets, `_/`, the DMZ, the lock and the bucket graph |
| [Who runs which command](./guide/commands) | `buckets check` for the AI and CI, `buckets refresh --web` to ask, a human to approve |
| [The approval flow](./guide/approval) | The review page, the confirmation code typed into a window of the operating system, and the terminal alternative |
| [Inspect](./guide/inspect) | The map, the DMZ matrix, symbol traces, projects, approvals, the timeline, impact simulations and the JSON for agents |
| [Projects and links](./guide/projects-and-links) | Nested projects, publishing code with `.external.ts`, and linking the source of another project with `buckets link` |
| [Claude Code](./guide/claude-code) | The skill and the 4 hooks that `buckets init` installs |
| [Supported agents](./guide/agents/) | The other coding agents, such as Codex CLI, Cursor and GitHub Copilot, and what their hooks enforce |
| [CI](./guide/ci) | Running the check in a pipeline with the version the lock asks for |
| [Threat model](./guide/threat-model) | What each layer stops, and what it does not |
| [Writing an adapter](./guide/adapters) | How the CLI talks to a language adapter |

## Reference

The [reference pages](./reference/) are generated from the source code on every docs build: the CLI help and messages, every rule id with the messages the CLI prints, lock differences, environment codes, the JSON report, the lock file, the config schema, the links registry, the hooks, the inspect snapshot and the adapter protocol.

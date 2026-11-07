---
title: Documentation
description: How slopbuckets keeps the architecture of a project explicit in buckets.config.json, what adopting it costs, and the reference for the buckets CLI.
---

# slopbuckets documentation

slopbuckets keeps the architecture of a TypeScript or JavaScript project in one file, `buckets.config.json`. The file lists the buckets, which are groups of files with one job each, the purpose of each bucket, which buckets and npm packages each one imports, and a one-line reason for every one of those imports. AI agents read and edit that file. Hooks in the agent stay silent while the code follows it. When an edit makes the code diverge, the hook shows the agent the problem with a fix in the code and a fix in the config.

Both fixes are valid, and no human approves anything. The reason the agent writes stays in the file for the next agent.

The CLI is called `buckets`.

```sh
npm install -g slopbuckets
cd your-project
buckets init       # empty config, agent hooks, AGENTS.md block and skill
buckets check      # every violation, in full
buckets inspect    # a read-only page with the buckets, dependencies and violations
```

`buckets check` exits with 0 when every rule passes, 1 when a rule is broken, 3 for an environment problem such as a missing config, and 64 when the command line is wrong.

## Before you adopt it

| Page | What it covers |
|---|---|
| [The costs of adoption](./guide/costs) | Declaring every package and dependency with a reason, public files, the first pending list, install size and what changes in a pull request |
| [If you know another tool](./guide/coming-from) | How Nx module boundaries, eslint-plugin-boundaries, Sheriff, dependency-cruiser and Tach map to slopbuckets, and when to keep them |

## Guide

| Page | What it covers |
|---|---|
| [Getting started](./guide/getting-started) | Install the CLI, run `init` and let an agent build the first architecture |
| [Install with an AI agent](./guide/install-with-an-agent) | The prompt that has a coding agent install slopbuckets and write the first config |
| [Concepts](./guide/concepts) | Buckets by glob, purpose, `public`, `dependsOn`, `packages`, `ignore`, nested projects and the rules |
| [Hooks](./guide/hooks) | The loop, when a hook warns and when it interrupts, the pending list and every message |
| [Commands](./guide/commands) | Every `buckets` command and the exit codes |
| [Inspect](./guide/inspect) | The graph, the matrix, the pending list, the file tree and the details panel |
| [Nested projects](./guide/nested-projects) | Several `buckets.config.json` in one repository |
| [Supported agents](./guide/agents/) | Which agents warn on edit, interrupt at the end, cover subagents and survive compaction |
| [CI](./guide/ci) | Running `buckets check` in a pipeline |
| [Performance](./guide/performance) | The cache and the time budgets of the hooks and the check |
| [What the check guarantees](./guide/guarantees) | What a passing check means, and what it cannot see |
| [Writing an adapter](./guide/adapters) | How the CLI talks to a language adapter |

## Reference

The [reference pages](./reference/) are generated from the source code on every docs build: the CLI help, every rule with its exact messages, the config schema, the hook phases and messages, the JSON report, the inspect snapshot and the adapter protocol.

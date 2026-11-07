---
title: Zed
description: What slopbuckets can do for Zed's own agent, which has no hooks, and how to get the hooks inside Zed through an external agent.
---

# Zed

This page covers the agent built into Zed. An external agent that runs inside Zed through ACP, such as Claude Agent, Codex or Gemini, keeps its own hooks, and its own page applies.

| Phase | Support | How |
|---|---|---|
| Warning on edit | no | Zed's agent has no hooks |
| Pending list on other tools | no | same |
| Interrupt on an invalid config | no | same |
| Interrupt at the end | no | same |
| Subagents | no | same |
| Compaction | no | same |

## Install

```sh
buckets init --agent zed
```

It writes only the shared instructions, which Zed's agent reads:

- the slopbuckets block in `AGENTS.md`
- the skill in `.agents/skills/slopbuckets/SKILL.md`

It writes no hook, and it reminds you to run `buckets init --git-hook` so every commit is checked. `buckets init --agent auto` picks Zed when the project has a `.zed` folder.

## How it works

The block in `AGENTS.md` tells the agent that the architecture lives in `buckets.config.json` and that it runs `buckets check` before it finishes. Nothing checks that it did.

Zed's only guard is `agent.tool_permissions` in your user settings, which matches tool calls against static patterns. In 2.0 an agent may edit `buckets.config.json` and run any `buckets` command, so slopbuckets has no rule to put there.

## Limits

- No warning on edit, no check at the end of a turn and no compaction event. Zed compacts threads without running any command.
- Zed reads `agent` settings only from your user settings file, not from a project's `.zed/settings.json`.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). For the hooks inside Zed, run an external agent through ACP, such as Claude Agent, Codex or Gemini, and install its adapter with `buckets init --agent <name>`. That Claude Agent runs the Claude Code hooks is inferred from Zed's docs, not confirmed.

## Check that it works

1. Ask Zed's agent "what are the slopbuckets rules for this project?". The answer should follow the `AGENTS.md` block.
2. Break a rule, for example with an import of a file of another bucket that is not its public file, and run `git commit`. The commit should fail with the `buckets check` report.

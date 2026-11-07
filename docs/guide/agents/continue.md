---
title: Continue
description: How buckets init sets up Continue, whose CLI loads hooks but never runs them.
---

# Continue

This page covers the Continue IDE extensions and the `cn` CLI.

| Phase | Support | How |
|---|---|---|
| Warning on edit | no | the CLI loads hooks but never runs them, and the IDE extensions have no hooks |
| Pending list on other tools | no | same |
| Interrupt on an invalid config | no | same |
| Interrupt at the end | no | same |
| Subagents | no | same |
| Compaction | no | same |

## Install

```sh
buckets init --agent continue
```

It writes only the shared instructions:

- the slopbuckets block in `AGENTS.md`
- the skill in `.agents/skills/slopbuckets/SKILL.md`

It writes no hook, and it reminds you to run `buckets init --git-hook` so every commit is checked. `buckets init --agent auto` picks Continue when the project has a `.continue` folder or a `.continuerc.json` file.

## How it works

The `cn` CLI reads Claude Code style hooks from six files, `.claude/settings.json` among them, and has helpers to fire them. As of October 2026, no code in the CLI calls those helpers, so no hook runs. The IDE extensions have no hook system.

The block in `AGENTS.md` tells the agent that the architecture lives in `buckets.config.json` and that it runs `buckets check` before it finishes. Nothing checks that it did.

## Limits

- No warning on edit and no check at the end of a turn.
- If Continue starts firing hooks, the slopbuckets Claude Code hooks in `.claude/settings.json` would run under `cn`. Its stop helper always sends `stop_hook_active: true`, so the stop hook would never block. A future adapter would need a Continue branch.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

1. Ask Continue "what are the slopbuckets rules for this project?". The answer should follow the `AGENTS.md` block.
2. Break a rule, for example with an import of a file of another bucket that is not its public file, and run `git commit`. The commit should fail with the `buckets check` report.

---
title: Any other agent
description: How to protect a slopbuckets project with an agent that has no adapter, through AGENTS.md, the skill, the git hook and CI.
---

# Any other agent

slopbuckets has hooks for a list of agents, and `buckets init --agent <name>` sets each one up. The [Supported agents](./) page lists them. An agent outside that list still works on the project. It gets the rules as text, and two checks outside the agent hold them.

## The rules in AGENTS.md

Every `buckets init` writes a block in `AGENTS.md` at the project folder, between `<!-- slopbuckets:start -->` and `<!-- slopbuckets:end -->`. It lists the essential rules: put code in `_/`, import through the alias, cross buckets only through DMZ files, never write any `buckets.lock.json` or `buckets.config.json`, never run plain `buckets refresh`, and run `buckets check` before finishing. When an `access` rule blocks a dependency the task needs, the agent stops and asks the human for the exact `access` line it proposes, the list it goes in and why. Running `init` again rewrites only the lines between the markers.

Most agents read `AGENTS.md`. If yours reads another file, such as `CONVENTIONS.md` or a rules folder, point that file at `AGENTS.md`, or copy the block there.

## The skill

`buckets init` copies the full skill to `.agents/skills/slopbuckets/SKILL.md`. Agents that support skills in `.agents/skills/` load it when the work touches the project. It explains the rules in depth, how to read the structure with `buckets inspect --json`, and what to do for each exit code of `buckets check`. For an agent that does not load skills, tell it to read that file before it edits files under the root bucket folder.

## The git hook

```sh
buckets init --git-hook
```

It adds a block to the git `pre-commit` hook that enters the project folder and runs `buckets check`, nested projects included. Any exit code other than 0 stops the commit. It works with `core.hooksPath`, worktrees and husky, and it keeps a hook you already have. Each person who clones the project runs the command once, because git does not copy hooks.

The hook fails open, like every slopbuckets integration. On a machine without the `buckets` command, it prints a warning and lets the commit through, and CI still runs the check.

Some agents commit with `--no-verify` or skip hooks by default. Check your agent's settings, or let it leave the commits to you.

## CI

The check in CI holds the rules for every change, whoever made it. Add `buckets check` to the pipeline as the [CI](../ci) page shows. A pull request that breaks a rule, or changes contracts without an approved lock, fails there.

## What you give up without hooks

An agent with hooks gets three more things: the lock guard refuses a write to any `buckets.lock.json` or `buckets.config.json` or a plain `buckets refresh` before it happens, each edit gets its `buckets check --file` report right away, and the agent cannot end its turn while `buckets check` fails. Without hooks, the agent can still break a rule or touch the lock or the config, and you find out at the commit or in CI. Review changes to `buckets.lock.json` and `buckets.config.json` in pull requests as you would review a change to the contracts themselves.

## Check that it works

1. Ask the agent "what are the slopbuckets rules for this project?". The answer should follow the `AGENTS.md` block.
2. Add `import { x } from './x';` to a file under the root bucket folder and run `git commit`. The commit should fail with the `buckets check` report.
3. Push the same change on a branch. CI should fail too.

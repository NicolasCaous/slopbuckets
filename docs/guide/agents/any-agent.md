---
title: Any other agent
description: How to keep a slopbuckets project in shape with an agent that has no adapter, through AGENTS.md, the skill, the git hook and CI.
---

# Any other agent

slopbuckets has adapters for a list of agents, and `buckets init --agent <name>` sets each one up. The [Supported agents](./) page lists them. An agent outside that list still works on the project. It gets the architecture and the rules as text, and two checks outside the agent hold them.

## The block in AGENTS.md

Every `buckets init` writes a block in `AGENTS.md` at the project folder, between `<!-- slopbuckets:start -->` and `<!-- slopbuckets:end -->`. It says four things: the architecture of the project is in `buckets.config.json`, the hooks warn when the code diverges from it, fixing the code and editing the config are both valid, and an agent without a stop hook runs `buckets check` before it finishes. The block writes the check command the way the project installed slopbuckets: `buckets check` for a global install, and `npx buckets check` for a copy in `node_modules`, whose `buckets` is not on PATH. Running `init` again rewrites only the lines between the markers.

Most agents read `AGENTS.md`. If yours reads another file, such as `CONVENTIONS.md` or a rules folder, point that file at `AGENTS.md`, or copy the block there.

## The skill

`buckets init` copies the skill to `.agents/skills/slopbuckets/SKILL.md`. Agents that support skills in `.agents/skills/` load it when the work touches the project. It explains how to read `buckets.config.json`, where a new file goes, when to create a bucket or declare a dependency, and how to write a purpose and a reason that help the next agent. For an agent that does not load skills, tell it to read that file before it changes the project.

## The git hook

```sh
buckets init --git-hook
```

It adds a block to the git `pre-commit` hook that runs `buckets check`, nested projects included. Exit code 1, for violations, and exit code 3, when the check cannot run, both stop the commit. The block runs the project's own copy in `node_modules/slopbuckets` first, the version the project pins, then a global `buckets`, and when it finds neither it prints a warning and lets the commit through. It keeps a hook you already have. Each person who clones the project runs the command once, because git does not copy hooks.

Some agents commit with `--no-verify` or skip hooks by default. Check your agent's settings, or let it leave the commits to you.

## CI

The check in CI holds the rules for every change, whoever made it. Add `buckets check` to the pipeline as the [CI](../ci) page shows.

## What you give up without hooks

An agent with hooks gets the pending list after each edit, a refusal when an edit would make `buckets.config.json` invalid or more broken than it is, and a block at the end of the turn while violations remain. [Hooks](../hooks) describes the loop. Without hooks, the agent finds the violations only when it runs `buckets check`, and you find them at the commit or in CI.

## Check that it works

1. Ask the agent "what are the slopbuckets rules for this project?". The answer should follow the `AGENTS.md` block.
2. Break a rule, for example with an import of a file of another bucket that is not its public file, and run `git commit`. The commit should fail with the `buckets check` report.
3. Push the same change on a branch. CI should fail too.

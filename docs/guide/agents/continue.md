---
title: Continue
description: Why slopbuckets installs no hooks for Continue, and what holds the rules there.
---

# Continue

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | no | slopbuckets installs no hooks for Continue |
| Feedback after edits | no | slopbuckets installs no hooks for Continue |
| Block the end of a turn | no | slopbuckets installs no hooks for Continue |

## Install

```sh
buckets init --agent continue
```

It writes only the shared instructions:

- the slopbuckets block in `AGENTS.md`
- the skill in `.agents/skills/slopbuckets/SKILL.md`

Continue reads project rules from `.continue/rules/`. If your version does not load `AGENTS.md` on its own, add a rule file such as `.continue/rules/slopbuckets.md` that says "Follow the slopbuckets rules in AGENTS.md before you edit files under the root bucket folder."

## How it works

The `AGENTS.md` block tells the agent the bucket rules, to leave every `buckets.lock.json` and `buckets.config.json` alone, to never run plain `buckets refresh`, and to run `buckets check` before it finishes. Nothing in Continue enforces these.

The Continue CLI loads hooks from `.claude/settings.json`, the file where `buckets init --agent claude` writes the Claude Code hooks. Its code does not appear to ever run them, so slopbuckets does not count on them. If you also use Claude Code in the project, those hooks stay in place for Claude Code.

## Limits

- Nothing stops Continue from writing the lock or the config, or from running `buckets refresh`.
- Nothing reports problems after an edit or runs `buckets check` at the end of a turn.
- The Continue CLI does not appear to run the hooks it loads. This was read from its code and not checked in a live session.
- Nothing here depends on the `buckets` command. The git hook fails open, like every slopbuckets integration. On a machine without the CLI, it prints a warning and lets the commit through.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does.

## Check that it works

1. Open the project with Continue and ask "what does AGENTS.md say about buckets.lock.json?". The answer should quote the slopbuckets rule.
2. Run `buckets init --git-hook`, make a commit with a relative import under the root bucket folder, and check that the commit fails with the `buckets check` report.

---
title: Aider
description: How buckets init sets up Aider, which has no hooks, and the lint and commit settings that bring the checks closer.
---

# Aider

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | no | Aider has no hooks, so nothing can refuse an edit or a command |
| Feedback after edits | partial | with `lint-cmd`, Aider runs `buckets check --file` after each edit and asks you before it fixes the problems |
| Block the end of a turn | no | Aider has no hooks |

## Install

```sh
buckets init --agent aider
```

It writes:

- `read: AGENTS.md` in `.aider.conf.yml`, so Aider loads the rules as a read-only file in every chat. A config you already have keeps every setting: a single `read` file becomes a list with both, and a list gets one more item. Each line `init` adds ends with `# slopbuckets`.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

`init` then suggests two settings it does not write for you, because they change how Aider works:

```yaml
lint-cmd: "buckets check --file"
git-commit-verify: true
```

- `lint-cmd` makes Aider run `buckets check --file <file>` after each edit. It replaces Aider's built-in linters for every language, so add a language prefix, such as `"typescript: buckets check --file"`, if you want to keep them for other files.
- `git-commit-verify: true` makes Aider's own commits run git hooks. Pair it with `buckets init --git-hook`, which installs the pre-commit hook that runs `buckets check`.

Aider reads `.aider.conf.yml` from your home folder, the root of the git repository and the folder you start it in. If the slopbuckets project sits below the repository root, start Aider in the project folder or copy the `read` line to the config at the root.

## How it works

At start, Aider adds `AGENTS.md` to the chat as a read-only file, so the model sees the rules before it edits anything.

With `lint-cmd`, Aider runs `buckets check --file` on each file it edits, from the root of the repository. When the check exits with a code other than 0, Aider shows the report and asks "Attempt to fix lint errors?". If you answer yes, the report goes to the model, which fixes the file.

With `git-commit-verify: true` and the pre-commit hook, each commit Aider makes runs `buckets check` with nested projects. A failing check stops the commit, and Aider shows the output.

## Limits

- Nothing stops Aider from writing `buckets.lock.json` or `buckets.config.json`, or from running `buckets refresh`. The rules in `AGENTS.md` ask it not to, and that is all.
- The lint feedback waits for your yes, and it checks one file at a time without the orphan rule or the lock comparison.
- By default Aider commits with `--no-verify`, so without `git-commit-verify: true` the pre-commit hook does not run for its commits.
- The `read` line needs no `buckets` command. The git hook fails open, like every slopbuckets integration. On a machine without the CLI, it prints a warning and lets the commit through. What Aider shows when `lint-cmd` names a command that is not installed was not verified.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). CI is the only check that a change cannot skip.

## Check that it works

1. Run `aider` in the project. The start-up lines should list `AGENTS.md` as a read-only file.
2. With `lint-cmd` set, ask Aider to add `import { x } from './x';` to a file under the root bucket folder. After the edit it should show the `buckets check --file` report and ask whether to fix it.
3. With `git-commit-verify: true` and the git hook, an Aider commit of a broken file should fail with the `buckets check` report.

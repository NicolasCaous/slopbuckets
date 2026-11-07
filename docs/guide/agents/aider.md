---
title: Aider
description: How buckets init sets up Aider, which has no hooks, and the test and commit settings that bring the check closer.
---

# Aider

| Phase | Support | How |
|---|---|---|
| Warning on edit | partial | with `test-cmd: "buckets check"` and `auto-test: true`, Aider runs the check after each edit and asks you before it sends the output to the model |
| Pending list on other tools | no | Aider has no hooks |
| Interrupt on an invalid config | no | Aider applies edits with no hook before them |
| Interrupt at the end | no | Aider has no hooks |
| Subagents | no | Aider has no subagents |
| Compaction | no | Aider summarizes chat history with no hook |

## Install

```sh
buckets init --agent aider
```

It writes:

- `read: AGENTS.md` in `.aider.conf.yml`, so Aider loads the rules as a read-only file in every chat. A config you already have keeps every setting: a single `read` file becomes a list with both, and a list gets one more item. Each line `init` adds ends with `# slopbuckets`. When the `read` key holds a value `init` cannot edit safely, such as a flow list with quotes, `init` leaves the file alone and tells you to add `AGENTS.md` to it by hand.
- the slopbuckets block in `AGENTS.md` and the skill in `.agents/skills/slopbuckets/SKILL.md`

`init` then suggests settings it does not write for you, because they change how Aider works:

```yaml
test-cmd: "buckets check"
auto-test: true
git-commit-verify: true
```

## How it works

After each edit, Aider runs `test-cmd` with no arguments. When `buckets check` exits with a code other than 0, Aider shows the report and asks "Attempt to fix test errors?". A yes sends the report to the model as the next message. `--yes-always` answers yes for you. Aider stops after 3 such rounds in a row.

`lint-cmd` runs after each edit too, but Aider appends the edited file's path to the command, and `buckets check` checks the whole project, so the test command fits better.

`git-commit-verify: true` makes Aider's own commits run the git pre-commit hook, which `buckets init --git-hook` installs. By default Aider commits with `--no-verify`.

## Limits

- Nothing refuses an edit or a command, and nothing runs at the end of a turn.
- The report reaches the model only after you answer yes.
- Aider runs `test-cmd` through `cmd.exe` on Windows, or through PowerShell when Aider runs inside it. A missing `buckets` command shows as a failed test.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci).

## Check that it works

In a project where `billing` and `payments` are buckets and the public file of `payments` is `src/payments/index.ts`:

1. Add the suggested settings to `.aider.conf.yml` and start Aider in the project.
2. Ask it to add `import { charge } from '../payments/client';` to `src/billing/invoice.ts`. After the edit, Aider should show the `buckets check` report with `billing -> payments: private file` and ask whether to fix it.

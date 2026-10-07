---
title: Zed
description: What slopbuckets can do for Zed's own agent, which has no hooks, and the tool permission rules to add to your user settings.
---

# Zed

This page covers the agent built into Zed. Claude Code running inside Zed through ACP is Claude Code: it reads `.claude/settings.json` and keeps every slopbuckets hook, as the [Claude Code](../claude-code) page describes.

| Protection | Support | How |
|---|---|---|
| Block lock writes and plain refresh | partial | static `agent.tool_permissions` rules in your user settings deny matching commands and paths, and `buckets update` without `--check` or `--json` |
| Feedback after edits | no | Zed has no hooks |
| Block the end of a turn | no | Zed has no hooks |

## Install

```sh
buckets init --agent zed
```

It writes only the shared instructions, which Zed's agent reads:

- the slopbuckets block in `AGENTS.md`
- the skill in `.agents/skills/slopbuckets/SKILL.md`

Zed reads `agent` settings only from your user settings file, not from a project's `.zed/settings.json`, so `init` cannot install the tool permission rules for you. Add them yourself: open the command palette, run "zed: open settings file", and merge this into the file.

```json
{
  "agent": {
    "tool_permissions": {
      "tools": {
        "terminal": {
          "always_deny": [
            { "pattern": "buckets\\.(?:lock|config)\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso" },
            { "pattern": "(?:^|[;&|(\\n\\x60])\\s*(?:(?:[\\w.-]+=\\S*|['\"]?(?:\\S*[\\\\/])?(?:npx|pnpx|bunx|npm|pnpm|yarn|bun|exec|dlx|x|env|nohup|sudo|time|command|xargs|node|tsx)(?:\\.exe|\\.cmd)?|(?:\\S*[\\\\/])?(?:bash|sh|zsh|cmd|pwsh|powershell)(?:\\.exe)?(?:\\s+[-/]\\S*(?:\\s+[^-/\\s]\\S*)?)*?\\s+(?:-[a-z]*c|/c|-command))\\s+(?:-\\S*\\s+(?:[^-\\s]\\S*\\s+)?)*)*(?:\\$\\((?:which|command\\s+-v)\\s+)?(?:\\S*[\\\\/])?['\"]?(?:slop)?buckets(?:\\.cmd|\\.exe|\\.ps1)?(?:@\\S*)?['\"\\x60)]?\\s+(?:--?[\\w-]+\\s+)*refresh(?:\\s*[\"']?\\s*(?:$|[;&|)])|\\s+(?:[^-\\s)]|-[^-]|--[^w]|--w[^e]|--we[^b]|--web[^\\s)\"']|--web\\s+-))" },
            { "pattern": "(?:^|[;&|(\\n\\x60])\\s*(?:(?:[\\w.-]+=\\S*|['\"]?(?:\\S*[\\\\/])?(?:npx|pnpx|bunx|npm|pnpm|yarn|bun|exec|dlx|x|env|nohup|sudo|time|command|xargs|node|tsx)(?:\\.exe|\\.cmd)?|(?:\\S*[\\\\/])?(?:bash|sh|zsh|cmd|pwsh|powershell)(?:\\.exe)?(?:\\s+[-/]\\S*(?:\\s+[^-/\\s]\\S*)?)*?\\s+(?:-[a-z]*c|/c|-command))\\s+(?:-\\S*\\s+(?:[^-\\s]\\S*\\s+)?)*)*(?:\\$\\((?:which|command\\s+-v)\\s+)?(?:\\S*[\\\\/])?['\"]?(?:slop)?buckets(?:\\.cmd|\\.exe|\\.ps1)?(?:@\\S*)?['\"\\x60)]?\\s+(?:--?[\\w-]+\\s+)*update(?:\\s+(?:[^-\\s;&|)][^\\s;&|)]*|-(?:[^-\\s;&|)][^\\s;&|)]*)?|--(?:[^cj\\s;&|)][^\\s;&|)]*|c(?:[^h\\s;&|)][^\\s;&|)]*|h(?:[^e\\s;&|)][^\\s;&|)]*|e(?:[^c\\s;&|)][^\\s;&|)]*|c(?:[^k\\s;&|)][^\\s;&|)]*|k(?:[^\\s;&|)\"'][^\\s;&|)]*|[\"'][^\\s;&|)]+))?)?)?)?|j(?:[^s\\s;&|)][^\\s;&|)]*|s(?:[^o\\s;&|)][^\\s;&|)]*|o(?:[^n\\s;&|)][^\\s;&|)]*|n(?:[^\\s;&|)\"'][^\\s;&|)]*|[\"'][^\\s;&|)]+))?)?)?)?))*\\s*[\"']?\\s*(?:$|[;&|#)]|<#)" }
          ]
        },
        "edit_file": { "always_deny": [{ "pattern": "buckets\\.(?:lock|config)\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso" }] },
        "write_file": { "always_deny": [{ "pattern": "buckets\\.(?:lock|config)\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso" }] },
        "delete_path": { "always_deny": [{ "pattern": "buckets\\.(?:lock|config)\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso" }] },
        "move_path": { "always_deny": [{ "pattern": "buckets\\.(?:lock|config)\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso" }] },
        "copy_path": { "always_deny": [{ "pattern": "buckets\\.(?:lock|config)\\.json|(?:^|[\\\\/\\s])bu[a-z0-9]{0,6}~[0-9]+\\.jso" }] }
      }
    }
  }
}
```

The rules apply to every project you open in Zed. They only deny, so they change nothing in a project without slopbuckets.

## How it works

Zed checks each tool call against `tool_permissions` before it runs, and `always_deny` wins over every allow rule and over the tool's default. The terminal tool matches the command text, and Zed splits a chain such as `npm test && buckets refresh` into its commands and checks each one. The file tools match the path. Zed matches without regard to case.

- The first pattern denies any command or path that names `buckets.lock.json` or `buckets.config.json`, or a Windows 8.3 short name such as `BUCKET~1.JSO`. A human owns both files, in every project.
- The second pattern denies `buckets refresh` unless the next word is exactly `--web` with no other flag after it. `buckets refresh --web > refresh.log 2>&1` passes.
- The third pattern denies `buckets update` unless one of the words after `update` is exactly `--check` or `--json`, which only report. A human updates the CLI. `buckets update --check` and `npx slopbuckets update --json` pass. The pattern reads words as plain text, so a quoted `"--check"` is denied too. A `#` or `<#` ends the command, so `buckets update --yes # --check` is denied.
- The second and third patterns match `buckets` only where a command starts: at the start, after `;`, `&`, `|` or `(`, after a runner such as `npx`, `pnpm exec` or `node`, or after a shell that runs its command text, such as `bash -c`, `cmd /c` or `pwsh -Command`. `gcloud storage buckets update` and `git commit -m "explain buckets update"` pass. A `)` ends a command, so `(cd sub && buckets refresh)` and `$(buckets update)` are denied.

## Limits

- The rules are a text match. They do not follow symbolic links, hard links or globs such as `bucket*`, which the hooks of other agents catch.
- They live in your user settings, so each person who uses Zed's agent on the project has to add them.
- Nothing reports problems after an edit, and nothing runs `buckets check` before the agent ends its turn.
- The rules need no `buckets` command, and no slopbuckets hook runs inside Zed. The git hook fails open, like every slopbuckets integration. On a machine without the CLI, it prints a warning and lets the commit through.

Rely on `buckets init --git-hook`, which runs `buckets check` before every commit, and on `buckets check` in [CI](../ci). They hold the rules whatever the agent does. If you want the full hooks inside Zed, run Claude Code in Zed through ACP.

## Check that it works

1. Add the rules to your user settings and open the project in Zed.
2. In the agent panel, ask it to "run buckets refresh". Zed should refuse the terminal command.
3. Ask it to "run buckets refresh --web". Zed should run it, or ask you first, as your other settings say.
4. Ask it to "run buckets update". Zed should refuse it, and should allow "buckets update --check".

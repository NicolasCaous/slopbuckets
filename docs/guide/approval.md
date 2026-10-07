---
title: The approval flow
description: How a contract change made by the AI reaches buckets.lock.json, with a human who reads the changes and types a confirmation code.
---

# The approval flow

The AI can edit every file in the project, including DMZ files, `buckets.links.json` and the bucket tree. It cannot write `buckets.lock.json` or `buckets.config.json`, because a human owns both: the lock records what the human approved, and the config holds the root folder, the alias and the [access rules](./concepts#access-rules). The skill tells the AI this, and the `PreToolUse` hook enforces it. Every contract change therefore waits for a human:

1. The AI changes a DMZ file, creates a bucket, adds a link or deletes an orphan chain.
2. `buckets check` finds a difference between the project and the lock and exits with code 2.
3. The AI runs `buckets refresh --web` in the background and sends the human the link it prints, with a summary of what changed and why.
4. The human reads the changes on the page, clicks Approve and types the confirmation code from the page into a window of the operating system.
5. The command writes the lock and exits with code 0. The check passes again.

The human can also skip the page and run `buckets refresh` in their own terminal, as described [at the end](#approving-in-a-terminal).

## An example

`invoices` needs an `audit` function from `log`. The AI writes it in `log/_/`, then adds it to the 2 contract files on the way:

```ts
// root/dmz/log/billing.ts
export { logger } from '@root/log/_/logger';
export { audit } from '@root/log/_/audit';

// root/billing/dmz/.parent/invoices.ts
export { logger } from '@root/dmz/log/billing';
export { audit } from '@root/dmz/log/billing';
```

The rules pass, so `buckets check` exits with code 2 and lists the differences:

```text
Lock differences
  Only a human approves these, with `buckets refresh` or `buckets refresh --web`.
  ~ dmz-changed   root/billing/dmz/.parent/invoices.ts
  + symbol-added  root/billing/dmz/.parent/invoices.ts  audit
  ~ dmz-changed   root/dmz/log/billing.ts
  + symbol-added  root/dmz/log/billing.ts               audit

buckets check: 4 lock differences.
Exit code 2: the rules pass, but the state differs from buckets.lock.json. ...
```

## The agent asks with refresh --web

The agent runs exactly `buckets refresh --web`, in the background. The `PreToolUse` hook allows this command and denies every other form of `buckets refresh`. The command runs the same check as `buckets refresh`. When a rule is broken, it prints the violations and exits with code 1 before opening anything. Otherwise it prints the diff and, on its last line, the link:

```text
4 changes since the last approved buckets.lock.json (2 added, 2 changed)

  ~ DMZ file edited       root/billing/dmz/.parent/invoices.ts
  + symbol added          root/billing/dmz/.parent/invoices.ts  audit
  ~ DMZ file edited       root/dmz/log/billing.ts
  + symbol added          root/dmz/log/billing.ts               audit

Open this link in a browser to review and approve. This command waits for the decision and stops after 30 minutes without activity on the page, or after 2 hours.
http://127.0.0.1:61684/
```

The agent sends the link to the human with a short summary: which DMZ files changed, which buckets, nested projects or links were created or removed, and why. Then it waits for the command to finish. It does not open the page or call its endpoints.

## The human approves on the page

The page shows every change since the last approval: versions, config, buckets, nested projects, links, and each DMZ file with its symbols and signatures. A config change shows line by line, as [Config changes](#config-changes) describes. A signature change appears even when the DMZ file did not change, because the type changed where it is declared. Each file can be expanded to show its text. A link shows its origin, mode and alias, and every symbol the linked project now publishes, stopped publishing or changed. A change inside a linked project that keeps its published signatures does not appear, because it needs no approval here.

At the top, the page shows a confirmation code of 6 characters. The code comes from a hash of the state the page shows, and its alphabet leaves out characters that are easy to confuse, such as `0` and `O` or `1` and `I`.

<figure class="shot">
  <img src="/img/refresh-web.webp" width="1440" height="900" alt="The refresh --web review page: the confirmation code EHDFEX in large amber letters, a note that the operating system will ask for it, and the list of changed DMZ contracts with Cancel and Approve buttons at the bottom." loading="lazy">
  <figcaption>The review page of <code>buckets refresh --web</code>, with its confirmation code and the changed contracts.</figcaption>
</figure>

When the human clicks Approve, the operating system opens its own window, on top of the other windows. It names the project and its folder, lists up to 8 of the changes, and asks for the code. It says how many characters the code has, but never shows the code itself:

```text
Approve 4 contract changes in the project "shop"?

Folder: /home/dev/shop

What this approves:
  ~ DMZ file edited root/billing/dmz/.parent/invoices.ts: +audit
  ~ DMZ file edited root/dmz/log/billing.ts: +audit

This writes buckets.lock.json in this project and in no other.

To approve, type the 6-character confirmation code shown on the review page in your browser, then click Approve. Click Cancel if you did not review the changes on that page yourself.
```

The human types the code and clicks Approve. The command writes the lock, prints that it did, and exits with code 0. Commit the lock together with the DMZ changes it approves.

The window is a WinForms window run by Windows PowerShell on Windows, `osascript` on macOS, and `zenity` or `kdialog` on Linux. The CLI runs each one from a fixed system path, never through `PATH`. Names from the project, such as file and symbol names, lose control characters, line breaks, bidirectional controls and zero-width characters before they appear in the window, so a file name cannot fake a line of the window text.

### What makes an approval count

- The code ties the window to what the human read. When Approve is clicked, the server computes the state again and refuses if it differs from the page. After the window closes, it computes the state once more and writes the lock only if the typed code is the code of that state. If the project changed in between, nothing is written and the page asks for a reload.
- The page never changes what it shows by itself. Every 5 seconds it asks the server whether the state still has the hash it shows. If not, a banner asks for a reload, and the code on screen stays the code of the state on screen.
- One confirmation window at a time. A second click while a window is open gets a message saying the window may be behind the browser.
- A wrong code writes nothing. The page says so, and the human can approve again.
- The lock is written to a temporary file in the same folder and renamed over `buckets.lock.json`. When the lock is a link, a junction or a folder, the write is refused.

### Several projects

With [nested projects](./projects-and-links), the page has one section per project that needs approval, each with its own code and its own Approve button. Each approval opens its own window and writes only that project's lock.

### How the command ends

| Result | Exit code | When |
|---|---|---|
| `approved` | 0 | every project with changes was approved |
| `current` | 0 | the lock already matched, or was approved elsewhere while the page was open |
| `rejected` | 1 | the human clicked Cancel in the window |
| `cancelled` | 1 | the human clicked Cancel on the page |
| `partial` | 1 | only some projects were approved |
| `timeout` | 1 | 30 minutes without activity on the page, or 2 hours in all |
| `interrupted` | 1 | the command was stopped, for example with Ctrl+C |

Only the page's own requests, which carry a token, count as activity. Exit code 1 means the agent stops and asks the human what to change. It does not retry on its own. The exact last lines are on the [CLI reference](../reference/cli#results-of-refresh-web).

### Machines without a desktop

`buckets refresh --web` checks before it starts whether a confirmation window can reach a human at this machine. It refuses in an SSH session, in a container, on Linux without `DISPLAY` or `WAYLAND_DISPLAY`, and when no dialog program exists:

```text
buckets refresh --web: cannot ask for approval on this machine. This is an SSH session, so a confirmation window would not reach the human at this machine. Ask the human to run `buckets refresh` in a terminal instead.
```

The agent then asks the human to run `buckets refresh` in their own terminal.

## Config changes

Only a human edits `buckets.config.json`. When an agent needs a change in it, such as an `access` line that allows a dependency, it stops and asks, with the exact line it proposes. The hooks deny any write to the file, also through a shell command that names it.

The lock stores the whole config, with the defaults filled in, so a change to it is a `config-changed` lock difference and waits for an approval like a contract change. The review lists what changed, one row per change: each `access` line added or removed with its list, a changed `access.default`, and every other key with its old and new value.

```text
~ config changed          buckets.config.json
    + access.allow  root/teams/search -> root/sql
    - access.deny   root/teams/search -> root/sql
    ~ maxDepth      2 to 3
```

The page, `buckets refresh` in a terminal and the confirmation window show the same rows. A lock written before version 4 kept only a hash of the config. When the config changed since such a lock, the review shows the whole current config and says the old values were not recorded. Approving writes a version 4 lock, and later reviews show each change.

## Approving in a terminal

`buckets refresh`, without a flag, does the same review in an interactive terminal. It needs stdin and stdout to be a TTY, so an agent's shell cannot run it, and the hook denies it before it starts. With nested projects it asks project by project:

```text
Changes since the last approved buckets.lock.json

  ~ DMZ file edited       root/billing/dmz/.parent/invoices.ts
  + symbol added          root/billing/dmz/.parent/invoices.ts  audit
  ~ DMZ file edited       root/dmz/log/billing.ts
  + symbol added          root/dmz/log/billing.ts               audit

  2 added, 2 changed.

Approve and write buckets.lock.json? [y/N] y
✓ Wrote buckets.lock.json. Commit it together with the DMZ changes it approves.
```

Only `y` or `yes` writes the lock.

## Review the lock in pull requests

The lock records what a human approved, so its diff is the part of a pull request to read. The [threat model](./threat-model) explains what the approval flow stops and what it does not.

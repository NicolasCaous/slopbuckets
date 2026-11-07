---
title: CI
description: Run buckets check in CI, so every pull request follows buckets.config.json whoever wrote it, with annotations on the pull request and the architecture diff for the reviewer.
---

# CI

The hooks keep agents in step with the config while they work, but some agents have no stop hook, a teammate may not have the CLI installed, and a human can commit too. `buckets check` in CI catches all of these on every pull request.

## Pin the version

A newer CLI can add a rule, so pin the version to get the same result on every machine. Add `slopbuckets` as a dev dependency and run the local copy:

```sh
npm install --save-dev slopbuckets
npx buckets check
```

Without a dev dependency, name the version in the command, as in `npx slopbuckets@2.0.0 check`.

The exit code fails the job: 1 for a violation, 3 for an environment problem, and 64 for a command line the CLI does not understand, so a typo in the workflow does not read as a violation. [Advice](../reference/rules#advice), the notes on short or generic reasons and on `ignore` globs that cover most of the project, never fails the job. The check covers every nested project listed in `projects`.

Install the dependencies first, because imports of workspace packages resolve through `node_modules`. Without the install, those imports are `import-unresolved`. The TypeScript adapter resolves imports with the project's `typescript` when it is version 5 or 6, so the check matches your build. With TypeScript 7 or without `typescript`, it uses the TypeScript 6 that slopbuckets installs with itself. A nested project with its own `package.json` needs its own install.

## GitHub Actions

```yaml
name: buckets
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      # slopbuckets is a dev dependency of the project, as in Pin the version
      - run: npx buckets check --base origin/${{ github.base_ref || 'main' }}
```

The check reads the files that git lists. It needs the checkout and the installed dependencies, and no build step.

On a GitHub Actions runner, `GITHUB_ACTIONS` is `true`, so `buckets check` also prints one `::error` line per violation on stderr. GitHub shows each one as an annotation on the file and line of the pull request. `--format github` turns these lines on outside Actions too.

## The architecture diff

Agents change the config without a human approval, so the pull request is where a person reads what changed in the architecture. The raw JSON diff of `buckets.config.json` is hard to read. `buckets check --base <ref>` runs the check and then lists the changes since the git ref, project by project:

```text
Architecture changes since origin/main:
  Added bucket `mail`: Sends invoice and receipt emails
  Added the dependency of `billing` on `mail`: Sends each invoice to the customer
  Added the package `node:fs` to `billing`: Writes invoice PDFs to the export folder
  Changed the public files of `billing` from src/billing/index.ts to src/billing/index.ts, src/billing/server.ts
  Added the export `send` to src/mail/index.ts, a public file of `mail`
  Removed the export `refund` from src/payments/index.ts, a public file of `payments`
```

It lists buckets added and removed, changed purposes, dependencies and packages added, removed or with a new reason, changed public files, and the names that the public files export or stopped exporting. When `GITHUB_STEP_SUMMARY` is set, as on Actions, it also appends the list to the summary page of the run as Markdown. It never changes the exit code. The ref must be in the clone, so check out with `fetch-depth: 0` or fetch the base branch first.

## Code scanning

`buckets check --format sarif` prints a SARIF 2.1.0 log with one result per violation. Upload it to code scanning, and every violation shows in the security tab and on the pull request:

```yaml
      - run: npx buckets check --format sarif > buckets.sarif
        continue-on-error: true
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: buckets.sarif
```

## JSON output

`buckets check --json` prints the [check report](../reference/report): the exit code, every violation with the fields its message uses, the environment errors, the advice and the projects that were checked. The process still exits with the report's `exitCode`, so you can save the report and fail the job in one step:

```sh
npx buckets check --json > buckets-report.json
```

## The cache

The check keeps its cache in `.buckets/cache/`, which `init` adds to `.gitignore`. CI starts without it, so the first run scans every file. That run is a cold check, which has a budget of 2 seconds for 10,000 files. See [Performance](./performance). Caching the folder between runs does not make it faster. Each cache file carries a random key kept in the git folder of the clone, and a fresh checkout has a new key, so the check ignores a restored cache and rebuilds it.

## The git hook

`buckets init --git-hook` installs a pre-commit hook that runs `buckets check` before every commit, whoever makes it. It catches violations before they reach CI, and it covers agents without a stop hook. The hook runs the project's own copy in `node_modules/slopbuckets` when there is one, the version the project pins, and otherwise the `buckets` on the PATH.

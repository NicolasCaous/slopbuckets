---
title: CI
description: Run buckets check in CI with the CLI version the lock asks for, after buckets link sync when the project uses links.
---

# CI

Each project pins the CLI version in `buckets.lock.json`, in the `cli` field, and `buckets check` refuses to run with a different version. In CI, install the version the lock asks for:

```sh
npx slopbuckets@$(node -p "require('./buckets.lock.json').cli") check
```

The command exits with the same codes as on a laptop, so a broken rule (1), an unapproved change (2) and an environment problem (3) all fail the job. It checks every nested project too, each against its own lock. Nested projects record their own `cli` version, and the check refuses a nested lock written by another version, so move all projects of a repository to a new version together.

The TypeScript adapter loads the `typescript` package from the project, so install the project's dependencies before the check. Without `typescript` in `node_modules`, the check exits with code 3 and the environment code `no-typescript`. A nested project with its own `package.json` needs its own install.

## Projects with links

Links in `link` mode are junctions or symlinks that stay out of git, so a fresh checkout does not have them. Without them, the check fails with `link-missing`, and a build that imports the linked code fails too. Run `buckets link sync` right after installing dependencies and before the build:

```sh
npx slopbuckets@$(node -p "require('./buckets.lock.json').cli") link sync
```

`link sync` recreates every missing link of the project and of its nested projects from `buckets.links.json`. Links in copy mode are committed and need nothing. A link whose origin lives outside the repository cannot be recreated in CI. Use copy mode for those. See [Projects and links](./projects-and-links#git-and-ci).

A link in `link` mode runs the code of the origin from its real folder, so the packages that code imports must be installed in the origin, and the check reports [`link-missing-dependency`](../reference/rules#link-missing-dependency) when they are not. When the origin has its own `package.json`, install its dependencies too, for example with `npm ci --prefix <origin folder>`. The type checking side resolves from the project that consumes the link, which the first `npm ci` covers.

## GitHub Actions

```yaml
name: buckets
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      # Only when a link in link mode points at a project with its own package.json:
      # - run: npm ci --prefix path/to/origin
      - run: echo "BUCKETS=slopbuckets@$(node -p "require('./buckets.lock.json').cli")" >> "$GITHUB_ENV"
      - run: npx "$BUCKETS" link sync
      - run: npm run build
      - run: npx "$BUCKETS" check
```

Leave out the `link sync` step when the project has no `buckets.links.json`. In that case the command prints that every link is present and does nothing, so keeping it costs little.

## JSON output

`buckets check --json` prints a [JSON report](../reference/report) with the exit code, the violations, the lock differences, the environment problem if any, and one entry per project. The process still exits with the report's `exitCode`, so you can save the report and fail the job in one step:

```sh
npx slopbuckets@$(node -p "require('./buckets.lock.json').cli") check --json > buckets-report.json
```

## The analysis cache

The check keeps its analysis cache in `.buckets/cache/`, which ignores itself in git. CI starts without it, which only means the first run analyzes every project. You can cache the folder between runs, keyed on the lock files and the source, but a cold run is correct too.

## Upgrading the CLI

To move a project to a new CLI version, a human installs the new version and approves with `buckets refresh` or `buckets refresh --web`. The diff shows the version change, and the new lock records it. CI then installs the new version from the lock.

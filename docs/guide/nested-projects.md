---
title: Nested projects
description: Several buckets.config.json files in one repository, listed in projects, each checked against its own config, and how hooks and imports work across them in a monorepo.
---

# Nested projects

A repository can hold more than one project, such as the packages of a monorepo, or an app and the SDK it publishes. Each project has its own `buckets.config.json`, and the enclosing project lists the folder of each nested one in `projects`:

```json
{
  "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v2.json",
  "version": "2.0",
  "ignore": ["**/*.test.ts"],
  "projects": ["packages/sdk"],
  "buckets": {
    "app": {
      "purpose": "Serves the web app",
      "files": ["src/**"],
      "public": null,
      "dependsOn": {},
      "packages": {
        "@acme/sdk": "Calls the public API through the typed client"
      }
    }
  }
}
```

The files under `packages/sdk/` leave the enclosing project. Its globs never match them, so no bucket owns them and none is reported as in no bucket. The nested project checks them against `packages/sdk/buckets.config.json`.

## One config per project

In a monorepo, give each package or app with its own `package.json` its own `buckets.config.json`, and list its folder in the `projects` of the config at the root. Each project then has its own buckets, rules and reasons, and the config at the root stays small.

- Each project resolves imports with its own `tsconfig.json`, the nearest one at or above each file inside the project. slopbuckets never uses the `tsconfig.json` of an enclosing project, so a nested project with code needs its own.
- An import of another package of the monorepo, such as `@acme/sdk` from the app above, is an external import for the importing project. The importing bucket declares it in `packages`, with a reason, like an npm package.
- A package that publishes its entry to npm marks the bucket of that entry with `external`, so its exports are not `export-unused`.
- When the root holds only tool configs and scripts, its config has `"buckets": {}` and lists those files in `ignore`. When every file of the root itself is ignored, the root needs no `tsconfig.json`.

To add a nested project, create `buckets.config.json` in its folder with at least `{"version": "2.0", "buckets": {}}`, and add the folder to `projects`. `buckets init` in that folder writes the same config, but it also installs agent hooks there, which the next section explains.

## Listed explicitly

Nested projects are a list, not something the check discovers. A `buckets.config.json` that turns up in a folder not listed in `projects` is a violation, so a stray config never splits the project without a decision. The search skips folders that `ignore` matches, so example and fixture configs under an ignored folder are not reported:

```text
packages/sdk/buckets.config.json: nested project not listed in projects
  choose one fix:
  fix code: delete packages/sdk/buckets.config.json if it is not a project
  fix config: add "packages/sdk" to projects
```

A listed folder without a `buckets.config.json` is a violation too:

```text
projects: packages/sdk has no buckets.config.json
  choose one fix:
  fix code: create packages/sdk/buckets.config.json
  fix config: remove "packages/sdk" from projects
```

A nested project can list projects of its own, and the check follows them recursively.

## Checking

`buckets check` checks the project of the nearest `buckets.config.json`, in the current folder or above it, and every nested project, and reports them together. A violation of a nested project starts with its folder:

```text
packages/sdk: src/utils/date.ts: in no bucket and not ignored
  choose one fix:
  fix code: move the file into a folder that a bucket owns
  fix config: add it to a bucket's files, or to ignore if it is not product code, such as a test, a script or a generated file
```

`buckets check --no-recursive` checks only the current project. The exit code is 3 when any project has an environment problem, else 1 when any project has a violation, else 0. A nested project that cannot be checked, for example because it has no `tsconfig.json`, gives an environment error for that project only.

`buckets show packages/sdk:client` prints the bucket `client` of the nested project. `buckets fmt` formats every config of the tree, and `buckets check --base <ref>` lists the architecture changes project by project.

## Hooks in a monorepo

The hook finds the project of each edited file from the path of that file: the nearest `buckets.config.json` at or above it, inside the folder the agent session opened. A session opened at the root of the repository that edits `packages/sdk/src/client.ts` checks the edit against `packages/sdk/buckets.config.json`. So the hooks installed at the root cover every project below it.

An agent reads its hook settings, such as `.claude/settings.json`, from the folder the session opens. Hooks installed only in `packages/sdk/` run only in a session opened in `packages/sdk/`. `buckets init` warns when it runs in a folder below the top of the git repository, and `buckets init --root` installs the agent hooks at the top folder as well.

## Code used from outside

A nested project that publishes a package has a public file whose users are outside the project. Without them in the project, every name in that file would be `export-unused`. Declare `external` on that bucket with a one-line reason:

```json
"client": {
  "purpose": "Typed client for the public API",
  "files": ["src/client/**"],
  "public": "src/client/index.ts",
  "external": "Entry point of the npm package",
  "dependsOn": {},
  "packages": {}
}
```

A bucket with `external` may also re-export by name from the buckets in its `dependsOn`, so one entry file can gather the names of several buckets.

## Inspect

`buckets inspect` has a project picker in the top bar, and the root project shows under the name of its folder.

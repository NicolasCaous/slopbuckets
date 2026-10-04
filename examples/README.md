# Examples battery

Each folder here is one end-to-end case for the `buckets` binary. The cases are the executable version of SPEC.md: a case states what the built CLI must print and which exit code it must return for a small TypeScript project.

## Running

```sh
npm run test:examples                        # builds the workspaces, then runs both test files
npx vitest run --project examples            # runs without building (cli/dist must exist)
npx vitest run --project examples -t lock-   # runs only the cases whose name contains "lock-"
```

`fixtures.test.ts` needs no CLI. It validates every `case.json`, checks that each project has its required files, and type-checks every project whose case expects a check with no violations.

`battery.test.ts` runs one test per case. Each run works in its own folder, `examples/.tmp/battery-<pid>-<time>/`, so two runs at the same time never touch each other's files. Before the first case, the battery copies `cli/dist/` into that folder, so a build started by another process cannot remove the CLI while the cases run. If a build is in progress when the battery starts, it waits for the build to finish. For each case it:

1. copies `<case>/project/` to `examples/.tmp/battery-<pid>-<time>/<case>/`, a gitignored folder inside the repository, so the root `typescript` package resolves from the copy
2. prepares the lock: `fresh` calls `computeLock` and `writeLock` from `cli/src/api.ts`, `none` writes nothing, and `file` keeps the `buckets.lock.json` committed in `project/`
3. copies `<case>/after/` over the copy and deletes the paths listed in `delete`
4. runs the copied `cli/dist/index.js` with `<args>`, with the copy as the working directory and as `CLAUDE_PROJECT_DIR`, and pipes `stdin` as JSON. With `"claudeProjectDir": "parent"`, `CLAUDE_PROJECT_DIR` is the folder above the copy instead
5. compares the result with `expect`

When every case passes, the battery removes its run folder. When a case fails, the run folder stays, so you can rerun the command by hand, and the battery prints its path. A failure message prints the command, the mismatches, the exit code, stdout and stderr. Delete old `examples/.tmp/battery-*` folders by hand when you no longer need them. `fixtures.test.ts` type-checks in its own `examples/.tmp/fixtures-<pid>-<time>/` folder and always removes it.

## Case format

```
examples/<case>/
  case.json
  project/        buckets.config.json, tsconfig.json, package.json, root/
  after/          optional, copied over the project after the lock is written
```

```json
{
  "description": "relative import inside a bucket fails",
  "lock": "fresh",
  "delete": [],
  "args": ["check", "--json"],
  "stdin": null,
  "expect": {
    "exitCode": 1,
    "violations": [{ "rule": "import-relative", "file": "root/log/_/logger.ts", "line": 1 }],
    "lockChanges": []
  }
}
```

| Field | Meaning |
|---|---|
| `description` | one line that says what the case checks |
| `lock` | `fresh`, `none` or `file` |
| `delete` | paths removed after `after/` is applied; a folder is removed with its contents |
| `args` | arguments for the binary, `["check", "--json"]` by default |
| `stdin` | JSON object sent on stdin, for hook cases |
| `expect.exitCode` | the exact exit code |
| `expect.violations` | compared as a set of `(rule, file)`; `line` is compared only when the case gives it |
| `expect.lockChanges` | compared as a set of `(kind, path)`; `symbol` is compared only when the case gives it |
| `expect.stdoutJson` | partial match against the parsed stdout: every key in the case must match, extra keys are ignored, arrays must have the same length |
| `expect.stdoutEmpty` | stdout must be empty (whitespace ignored) |
| `expect.stderrIncludes` | a string or a list of strings that stderr must contain |
| `expect.filesExist`, `expect.filesMissing` | paths checked in the project copy after the run |

An omitted `violations` or `lockChanges` is not compared. An empty array means the report must have none. For every `check --json` run, the battery also checks that stdout is a `CheckReport` whose `exitCode` equals the process exit code.

### Extensions to the SPEC.md format

- `expect.violations[].file` can be an array of paths. Any one of them matches. `graph-cycle` cases use this because SPEC.md lets the CLI report any file that adds an edge of the cycle.
- `expect.exitCode` can be `"nonzero"`, for commands whose exact failure code SPEC.md leaves open, such as `refresh` without a TTY.
- `lockPatch` (with `"lock": "fresh"`) is shallow-merged into the computed lock before `writeLock`. The version cases use it to fake a lock from another CLI or adapter version.
- `stdin` strings can contain `${PROJECT}`, replaced by the absolute path of the project copy. In a string that starts with it, the rest of the path gets the native separator, like the paths Claude Code sends.
- `expect.idempotent: true` runs the command a second time and requires the same exit code and a byte-identical project tree. `init-yes` uses it.
- `setup` is a list of CLI argument lists, such as `[["link", "update"]]`, run in the project copy before the lock is computed. Each must exit with 0, or the case fails during setup.
- `"lock": "fresh"` writes a fresh lock in every project: the copy itself and each project nested in it, found with `listProjects` from `cli/src/api.ts`. `lockPatch` applies to the top project only. A nested project that `after/` adds has no lock, so the check reports `lock-missing` for it.
- `claudeProjectDir` is `"project"` (the default) or `"parent"`. With `"parent"`, the battery sets `CLAUDE_PROJECT_DIR` to the run folder, the folder above the project copy, so a hook case runs as a session opened above the project. The `hooks3-*` cases use it. A case that records projects for a session needs no `session_id`, because the state file lives outside the copy and would outlast the run.
- `expect.violations[].project` and `expect.lockChanges[].project` name the project of the item: `.` for the project where the check ran, or the path of a nested project. They are compared only when the case gives them, and `file` and `path` are then relative to that project.

## Writing a case

- Break exactly one rule per violation case, so the expected sets stay exact. Copy a passing project such as `valid-readme` and change one thing.
- Write the expected report from SPEC.md, not from what the CLI prints today.
- Git does not keep empty folders. Every `_/` and `dmz/` folder needs at least one file, and every DMZ file must be used, or the case also gets a `dmz-orphan`.
- Valid projects must type-check: `npx tsc -p examples/<case>/project --noEmit`. Use only node builtins and packages that resolve from the repository root, or add a local `declare module` file inside a bucket's `_/`.
- `project/buckets.lock.json` is only allowed with `"lock": "file"`, and `after/` never contains a lock.
- `.gitattributes` in this folder keeps the line endings of `lock-dmz-crlf-only` exactly as committed.
- A nested project in a case needs its own `buckets.config.json`, `tsconfig.json` and `package.json`, and the parent's `tsconfig.json` excludes its folder, so the parent type-checks without the nested alias.
- Link cases keep the origin project in `vendor/`, outside the root folder, and commit the link in copy mode: the origin's `.external.ts` files and every file they import, in the same paths under `<bucket>/_/links/<name>/`, plus `buckets.links.json` and the `paths` entry of the origin's alias in `tsconfig.json`. A junction or symlink cannot be committed, so link mode is covered by the unit tests.

# Examples battery

Each folder here with a `case.json` is one end-to-end case for the built `buckets` binary. A case gives a small project and states what the CLI must report for it: the exit code, the violations, the exact text, or for a hook sequence the output and the pending list after each step. The cases are written from the docs and the contracts in `cli/src/contract/`, not from what the CLI prints today.

The `check-*` cases cover the rules of `buckets check`. The `hook-*` cases cover hook sequences. `fixtures/` holds the inspect snapshots and is not a case.

## Running

```sh
npm run test:examples                                  # builds, then runs the battery
npx vitest run --project examples                      # runs without building (cli/dist/index.js must exist)
npx vitest run --project examples -t check-glob-empty  # runs only the cases whose name contains check-glob-empty
```

`battery.ts` holds the runner, and `battery-1.test.ts` to `battery-4.test.ts` each run a quarter of the cases, which vitest runs in parallel. The tests come in two groups:

- `case files` validates every `case.json` against the contract format and fails with every problem it finds, such as an unknown field or a rule id that does not exist. It needs no CLI.
- `examples battery, shard <n> of 4` runs one test per case of the shard.

For each case the runner:

1. copies `<case>/project/` to `examples/.tmp/<run>/<case>/project/`. The folder is inside the repository so that the root `typescript` package resolves from the copy, and every shard of every run gets its own `<run>` folder, so two runs at the same time never touch each other's files.
2. links each npm workspace of the copy's `package.json` into `node_modules/<name>`, as `npm install` does. It reads exact folders and folders ending in `/*`, and makes a junction, which needs no rights on Windows.
3. runs `git init`, `git add -A` and a commit in the copy, because the CLI takes its files from `git ls-files -co --exclude-standard`. Git variables of the outer process are removed, so git never touches the repository around the copy.
4. runs each `setup` command, copies `<case>/after/` over the copy and removes the paths in `delete`. Files from `after/` stay uncommitted, as an agent's changes would.
5. runs `node cli/dist/index.js` with the copy as working folder and `CLAUDE_PROJECT_DIR` set to the copy, or to the folder above it with `"claudeProjectDir": "parent"`. A command case runs once with `args`. A hook sequence runs `hook --agent <agent> <event>` once per step, with the step's `event`, writes the step's `files` first and pipes its `payload` on stdin.
6. compares the result with `expect`. Each CLI call has 30 seconds.

When every case passes, the runner removes the run folder. When one fails, the folder stays so the command can be rerun by hand, and the failure prints the project path, the command, every mismatch, the exit code, stdout and stderr. Delete old `examples/.tmp/` folders by hand.

## Case format

The format is `cli/src/testing/case-format.ts`, and `cli/src/contract/README.md` has the table of fields. In short:

```
examples/<case>/
  case.json
  project/   the project; every case needs its own buckets.config.json, tsconfig.json and package.json
  after/     optional, copied over the project after the commit
```

```json
{
  "description": "an import of a file of another bucket other than its public file gives import-private",
  "expect": {
    "exitCode": 1,
    "violations": [{ "rule": "import-private", "file": "src/app/main.ts", "line": 2 }]
  }
}
```

How the runner reads the fields that the contract leaves open:

- `check --json` prints the `CheckResult` of `cli/src/contract/engine.ts`: `exitCode`, `violations`, `environment`, `advice` and `projects`. The runner checks that `exitCode` equals the process exit code and that the lists are arrays.
- `expect.violations` is a set. Each actual violation goes through `violationLocation` and must match one expected item, and each expected item must match one actual violation. `file`, `line` and `project` are compared only when the case gives them, and `file` is relative to the violation's project. Use `stdoutJson` to pin how many violations there are or the fields of one, such as the `problem` of a `config-invalid`.
- `expect.violations` in a command case needs `--json` in `args`, and `expect.message` needs a run without it. In a hook step, `violations` is matched against the session's pending list.
- `expect.advice` is a set of `{ advice, at?, project? }` matched the same way against the `advice` of the report, with `at` written as the messages write a config path, such as `buckets.billing.dependsOn.log`. It needs a command case with `--json`.
- `expect.message` is compared after turning `\r\n` into `\n` and removing trailing whitespace. For `check` it is stdout. For a plugin agent (OpenCode, Pi, Amp) the hook prints `{"kind": ..., "text": ...}`, and the message is `text`. For any other hook it is the first string found under the keys that `cli/src/contract/README.md` lists, such as `additionalContext`, `contextModification` or `reason`, in the JSON on stdout. If stdout is not JSON, it is stdout itself, and if stdout is empty and the hook exits with 2, it is stderr.
- A hook step names the phase in `hook` and the exact event in `event`, the name the adapter registers: `pre-tool-use` for a Claude Code edit, `after-tool` for Gemini's post-tool fallback, `pre-edit` for a plugin agent. A step that checks the list after the tool uses the adapter's post-tool event.
- `expect.decision` is the decision the hook output carries: `silent`, `context`, `deny` or `block`. A plugin agent's output carries it in `kind`. `cli/src/contract/README.md` says how the runner reads the others. Every hook step also fails when its stdout JSON approves the call with an `allow`, an `approve` or `"continue": true`.
- `expect.pending` reads `.buckets/sessions/<session_id>[-<agent_id>].json` under the session root, with the ids from the step's payload. Without a `session_id`, it reads the newest state file there. No state file is an empty list.
- `expect.idempotent` runs the command again and compares the project tree, `.git/` left out.

## Adding a case

1. Copy a case close to the one you need, such as `check-clean-project`, and give the folder a name that starts with `check-` or `hook-` and says what it checks.
2. Change one thing, so the case breaks exactly one rule and its expected set stays exact. A case that should fire lists every violation the project has. A case that should not fire expects `"violations": []`.
3. Keep every export of a public file imported by another bucket, every `dependsOn` entry used and every glob matching a file, or the case also gets `export-unused`, `dependency-unused` or `glob-empty`.
4. A file that `project/.gitignore` excludes is also excluded by the repository, so put it in `after/`. `check-gitignored-files-not-counted` does this.
5. Run the case alone with `-t <case>`.

`check-env-no-typescript` commits `project/node_modules/typescript/package.json`, a package whose `main` file is missing, so the project's `typescript` cannot load from the copy and the check uses the TypeScript 6 of slopbuckets. The `.gitignore` next to its `case.json` takes that file back from the repository's `node_modules/` rule. That `.gitignore` is not copied into the run.

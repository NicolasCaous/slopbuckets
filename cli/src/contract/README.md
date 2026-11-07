# Contracts of slopbuckets 2.0

Every round builds against these files. They depend only on Node built-ins and on each other. Import from the single file you need. A change here changes the work of every other agent, so change it only on purpose and say so. `messages.ts` and the files it imports have no Node import, because the inspect page bundles them for the browser.

The principle behind every message: everything is explicit, every error shows in full once and then as its one-line reminder, and nothing is hidden or collapsed into a count. A full form lists every import of its group. Every full form ends with what to do, and `choose one fix:` stands above two fix lines.

## The config

```json
{
  "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v2.json",
  "version": "2.0",
  "ignore": ["**/*.test.ts", "scripts/**"],
  "projects": ["packages/sdk"],
  "buckets": {
    "billing": {
      "purpose": "Issues and charges invoices",
      "files": ["src/billing/**"],
      "public": "src/billing/index.ts",
      "dependsOn": { "payments": "Charges each invoice through the gateway" },
      "packages": { "zod": "Validates the invoice payloads of the public API", "node:fs": "Writes invoice PDFs to the export folder" }
    },
    "payments": {
      "purpose": "Talks to the payment gateway",
      "files": ["src/payments/**"],
      "public": ["src/payments/index.ts", "src/payments/server.ts"],
      "dependsOn": {},
      "packages": { "stripe": "Calls the Stripe API for charges and refunds" },
      "external": "Entry point of the npm package"
    },
    "app": {
      "purpose": "Starts the server and wires every route",
      "files": ["src/app/**"],
      "public": null,
      "dependsOn": { "billing": "Mounts the invoice routes", "payments": "Mounts the webhook route of the gateway" },
      "packages": { "express": "Serves the HTTP routes" }
    }
  }
}
```

`config.ts` has the types (`BucketsConfigV2`, `BucketDef`), the bucket name pattern, the key lists and three helpers. `site/schema/v2.json` is the source of truth, and `contract.test.ts` checks that the key lists match it.

- `version` and `buckets` are required at the top level. `ignore` and `projects` are optional and default to `[]`.
- `configVersionStatus(version)` decides how the CLI treats `version`. `supported` is major 2 with a minor up to the minor of `CONFIG_VERSION` (`"2.0"`). `newer` is a greater major, or major 2 with a greater minor: the engine stops with the environment error `config-newer` (exit 3) before it validates anything else, so the unknown fields of a newer format are never `config-invalid`. Its message is `configNewerMessage(version, cliVersion)`. `invalid` (not `<major>.<minor>`, or a major below 2) is `config-invalid` at `["version"]`, and a missing `version` is `{ kind: 'missing', at: [], field: 'version' }`.
- In a bucket, `purpose`, `files`, `public`, `dependsOn` and `packages` are required, and `external` is optional.
- `public` is a string, a non-empty array of strings without repeats, or null. `publicFiles(value)` reads every form. An empty array is `{ kind: 'empty', at: [..., 'public'] }`, an empty entry is `{ kind: 'empty', at: [..., 'public', i] }`.
- `packages` maps every external module the files of the bucket import to a one-line reason, like `dependsOn` maps buckets. Keys are package names without a subpath (`lodash`, `@scope/pkg`) and Node built-ins with the prefix (`node:fs`). `packageKey(specifier)` turns any specifier into its key: `lodash/merge` is `lodash`, `fs` and `fs/promises` are `node:fs`. A key with `packageKey(key) !== key` is `{ kind: 'package-name', bucket, name, key }`. An empty reason is `{ kind: 'empty', at: ['buckets', b, 'packages', name] }`.
- The check applies `ignore` first and then the bucket globs. A file that `ignore` matches leaves the architecture, so it is ignored even when a bucket's `files` also matches it, and it needs no `packages` entry. `file-overlap` means two or more buckets match the same file.

## Files

`rules.ts` lists the 18 rule ids in `RULE_IDS`. `RULES` maps each id to its hook behavior: `preTool` is `warn` for every rule except `config-invalid`, and `stop` is always `interrupt`. Each entry has a one-sentence `detects` text for docs and inspect. The file also holds the advice ids (`ADVICE_IDS`, `ADVICE`), the thresholds of advice and `reasonAdvice()`, the exit codes (0 none, 1 violations, 3 environment error, 64 usage error; 2 is retired), the environment error codes, `CONFIG_FILE` and `CONFIG_VERSION`.

`violation.ts` defines `Violation`, one variant per rule, discriminated by `rule`, and `Advice`. Paths are relative to the project with `/`, and `project` is `.` or the nested project folder relative to the session root. `violationKey(v)` is the stable id the session uses to remember what it showed. `violationLocation(v)` gives the file and line that the battery matches. `violationBuckets(v)` lists the buckets of a violation for inspect and `check --summary`. `sortViolations` and `sortAdvice` give the order every output uses, and `groupUnowned` builds the file-unowned violations (below). A config with several problems gives one `config-invalid` per problem, each with a structured `ConfigProblem`.

`messages.ts` renders every text an agent or human reads: `renderFull`, `renderSummary` (at most 120 characters), `renderPending` (pre-tool context with `[NEW]`, `[OLD]` and `[RESOLVED]`, or an empty string when there is nothing to say), `renderStop(list, { advice?, repeated? })`, `renderInterrupt`, `renderCheck(list, environment, advice)`, `renderCheckSummary(list, environment, advice)`, `renderAdvice`, `renderAdviceNote` (the advice under `adviceHeader`, for the clean-stop note and the pre-tool), `renderEnvironment` and `configNewerMessage`. `renderInterrupt(problems)` is the pre-edit deny reason for config-invalid and says the edit was not applied. An adapter that only runs after the edit landed uses `renderInterrupt(problems, { applied: true })`. A violation of a nested project starts with `<project>: `. `messages.reference.txt` holds every form, and `messages.test.ts` checks it. The words agent can quote it.

`../testing/samples.ts` has one violation per rule (`SAMPLES`), the other message forms (`SAMPLE_VARIANTS`), one advice per id (`ADVICE_SAMPLES`) and the other advice forms (`ADVICE_VARIANTS`).

`engine.ts` is the interface of the rule engine: `checkAll(root, { recursive? })`, `checkEdit(root, edit | edits)`, `recheck(root, previous)` and `snapshot(root, { changed? })`. `buckets check --json` prints exactly one `CheckResult` (`exitCode`, `violations`, `environment`, `advice`, `projects`), with nothing added or left out. `createFakeEngine(script)` in `../testing/fake-engine.ts` is a scripted implementation for tests: `checkEdit` returns the list scripted for the edited path and keeps it as the new disk state, unless it holds `config-invalid`. `set()` replaces the disk state, `calls` records every call, and `script.advice` is what every result carries as advice.

`session.ts` is the hook state in `.buckets/sessions/<session_id>[-<agent_id>].json`, version 2. Besides `shown`, `pending`, `dirty` and `stopBlocked` it keeps `stopKeys` (the keys of the last blocking stop, across turns) and `environmentShown` (`environmentKey(e)` of every environment error already shown as context). `parseSessionState` turns a stale or broken file, a version 1 file included, into an empty state. The hooks decide what to show from it in `../hooks/session.ts`: `advance(state, current)` returns what to show and the state to save, and `resetShown` is for post-compact.

`hooks.ts` defines the phases, the normalized `HookInput`, the `HookDecision` (`silent`, `context`, `deny`, `block`), `PHASE_DECISIONS` and the `HookCore` signature, with the obligations of the core in its doc comment. A `context` decision must never go out with an "allow".

The adapter protocol, ABI 2, lives in the adapter package, in `adapters/ts/src/protocol.ts`. `info` returns name, version and extensions. `analyze` takes files, the public files that need export details, and in-memory contents for a simulated edit. It returns the imports of each file, with `typeOnly` per name, the exports of each public file and the resolution inputs with their hashes. An unresolved target says what kind of specifier it was: `{ unresolved: 'relative' | 'paths' | 'workspace' | 'package' | 'other', pattern? }`.

`snapshot.ts` is the inspect snapshot v2. `SnapshotBucket.public` is a list, `[]` for a closed bucket. `SnapshotBucket.packages` lists the declared and imported packages with a state. `SnapshotImport.private` marks an import of a file that is not public. `SnapshotProject.advice` holds the advice. Files are stored as `FileGroup`s, one per folder and owner, so 50,000 files take about 1 MB. `../testing/fixtures.ts` generates the example snapshots in `examples/fixtures/snapshots/`. Regenerate them with `UPDATE_FIXTURES=1 npx vitest run cli/src/testing/fixtures.test.ts`.

`../testing/case-format.ts` is the v2 `case.json` format, described below.

## Rules and their shapes

| Rule | One violation per | Shape beyond `rule` and `project` |
|---|---|---|
| `config-invalid` | problem | `problem: ConfigProblem` |
| `config-cycle` | cycle | `cycle`, `edges: { from, to, reason, import: ImportRef \| null }[]` |
| `dependency-undeclared` | bucket pair | `from`, `to`, both purposes, `imports: BucketImport[]`, `public: string[]`, `dependents: DeclaredBy[]` (up to 3), `reversePath: string[] \| null` |
| `dependency-unused` | dependsOn entry | `from`, `to`, `reason` |
| `import-private` | bucket pair that declares the dependency | `from`, `to`, `imports: ImportRef[]`, `public: string[]` |
| `import-unresolved` | file and specifier | `bucket`, `file`, `line`, `specifier`, `kind: 'relative' \| 'paths' \| 'workspace'`, `pattern` |
| `import-ignored`, `import-dynamic`, `import-namespace` | statement | as in the first 2.0 contract |
| `file-unowned` | file, all-unowned folder, or the whole project when there are no buckets | `{ file }`, `{ folder, count }` or `{ noBuckets: true, count, folders: FolderCount[], files }` |
| `file-overlap`, `glob-empty`, `project-undeclared` | as before | as before |
| `public-missing` | listed public file | `bucket`, `public` (the listed file), `state`, `owner` |
| `public-not-interface` | public file and problem | `bucket`, `public`, `line`, `kind` |
| `export-unused` | public file and name | `bucket`, `name`, `public`, `line` |
| `package-undeclared` | bucket and package key | `bucket`, `purpose`, `package`, `imports: PackageImport[]`, `declaredBy: DeclaredBy[]` (up to 3) |
| `package-unused` | packages entry | `bucket`, `package`, `reason` |

`ImportRef` is `{ file, line, target, names: ImportName[] }` with `ImportName = { name, typeOnly }`. `BucketImport` adds `private`. `PackageImport` is `{ file, line, specifier }`. `DeclaredBy` is `{ bucket, reason }`. Grouped violations are keyed by their group (`[from, to]`, `[bucket, package]`), so a new import in the same group keeps the key.

`ConfigProblem` gains two kinds. `bucket-renamed` (`from`, `to`, `referencedBy`) replaces the unknown-bucket problems of an edit that removes a bucket key still named by a dependsOn and adds a new key; its fix says to rename the key and every dependsOn entry in the same edit. `package-name` (`bucket`, `name`, `key`) is a packages key with a subpath or a bare built-in.

The pre-tool and stop matrix of the new rules is the matrix of the dependency rules: `warn` before a tool, `interrupt` at the stop.

## Advice

Advice is a separate list, `CheckResult.advice: Advice[]`, never in `violations`. It never counts for the exit code, never enters the pending list, and never makes a stop block. It shows in the stop text, after the violations of a stop that blocks anyway, in the `note` of a stop with nothing to block when the session wrote a purpose or reason with reason-generic advice (once, see `HookState.adviceSeen` in ../hooks/session.ts), under the pending list of the first pre-edit or pre-tool after an edit of the config that wrote such a purpose or reason (once, see `HookState.adviceShown`), and in `buckets check`, after the violations and environment errors, under `adviceHeader()`. Each advice has `project` and `at`, the config path it is about.

- `reason-generic` (`text`, `why: 'short' | 'generic'`): a purpose, a dependsOn or packages reason, or an external line for which `reasonAdvice(text, bucketNames)` is not null. Generic means that only bucket names, a generic verb (uses, needs, calls, imports, depends on) and the words a, an, and, the, it, on, to, for are left. Short means fewer than three words.
- `ignore-large` (`glob`, `count`, `total`): one per ignore glob (`at: ['ignore', i]`) that matches more than 20% of the source files of the project (`IGNORE_LARGE_SHARE`), where source files are every file the adapter reads, ignored ones included. Files whose path names a test, script, fixture or example (`TOOLING_PATH` in `../engine/rules.ts`, such as `*.test.ts`, `scripts/` or `examples/`) do not count toward the share, because they belong in ignore; `count` stays the number of files the glob matches. The message says once that those files are outside every rule.

## Obligations of the engine (R2)

- Read `version` before anything else and stop with `config-newer` as described above. Require `version` and `packages`, accept every form of `public`, and validate packages keys with `packageKey`.
- Resolve each file with the nearest tsconfig.json inside the project. Report `import-unresolved` for an unresolved target of kind `relative`, `paths` or `workspace`, only in files of a bucket. While any import of a bucket is unresolved, hold back the `dependency-unused` of that bucket and the `export-unused` of every bucket that the unresolved import could reach (any bucket, when the target is unknown). A `package` kind is an npm package that is not installed: it counts as the package `packageKey(specifier)` for the packages rules and is not import-unresolved.
- Report `import-private` once per declared pair with every private import, file, line and names. For an undeclared pair, report no import-private: put the private imports in the `dependency-undeclared` of the pair with `private: true`, and fill `public` with the public files of the target. Names imported through a private path count as used for `export-unused`.
- Fill `dependency-undeclared.dependents` with up to 3 buckets that declare the target, sorted by name, and `reversePath` with the dependsOn path from the target back to the importer when one exists (the shortest, ties broken by name).
- Fill `config-cycle.edges` with the reason of each edge and the first import that backs it, by file and line, or null.
- Report `public-missing`, `public-not-interface` and `export-unused` per listed public file. `import-private` means the target is not one of the listed files.
- Map every external import of a bucket file, type-only imports included, to `packageKey(specifier)` (`{ builtin }` and `{ package }` targets, and unresolved `package` targets), and report `package-undeclared` (grouped per bucket and key, `declaredBy` up to 3, sorted by name) and `package-unused`. Ignored files are left out.
- Carry `typeOnly` per name into every `ImportRef`. The fix lines then suggest `export type { X }` for names that every import takes as types only, and both forms when names are mixed.
- Call `groupUnowned(project, unowned, all, UNOWNED_GROUP_MIN, config.buckets.length === 0)`: with no buckets the project gets one `noBuckets` violation.
- Compute the advice and return it in `CheckResult.advice` and `SnapshotProject.advice`, sorted with `sortAdvice`.
- For `checkEdit` of a config, compare the edited text with the config on disk and emit `bucket-renamed` in place of the unknown-bucket problems of a renamed key.
- Fill `SnapshotBucket.public` (one entry per listed file), `SnapshotBucket.packages` and `SnapshotImport.private`.

## Obligations of the hooks (R2)

- `config-newer` never denies an edit and never blocks a stop. Show `renderEnvironment(e)` once per session as context, remembered in `environmentShown`.
- The pre-edit deny for a renamed bucket carries the `bucket-renamed` problem.
- At a stop that blocks, pass `advice` from the CheckResult and `repeated: true` when every key of the list is in `stopKeys`, then save the keys of the list in `stopKeys`. A stop with no violation empties `stopKeys`. Advice alone never blocks: a stop with nothing to block answers `note` with the reason-generic advice on purposes and reasons the session wrote, once.
- The first pre-edit or pre-tool after an edit of the config, or after a change of it on disk, adds `renderAdviceNote` with the reason-generic advice that is new: not in `adviceSeen` and not in `adviceShown`. It then adds those keys to `adviceShown`, which the stop empties. The clean-stop note does not read `adviceShown`, so it still lists that advice for the user.
- The pending list shows every violation in full once and then as its one-line reminder, before every tool call, never collapsed.

## Obligations of the CLI (R2)

- `buckets check --summary` prints `renderCheckSummary`: counts per rule and per bucket, the advice per id, and every environment error in full. Hooks never use it.
- `buckets check` prints `renderCheck(violations, environment, advice)`.
- A command line the CLI does not understand exits with `EXIT_CODES.usage` (64).
- `buckets init` writes `"version": "2.0"` (`EMPTY_CONFIG` already does).

## Case format

A case is a folder `examples/<case>/` with `case.json`, `project/` and an optional `after/` that is copied over the project before the run. There is no lock. A case is either a command case or a hook sequence.

```json
{
  "description": "an import of a private file of another bucket",
  "args": ["check", "--json"],
  "expect": {
    "exitCode": 1,
    "violations": [{ "rule": "import-private", "file": "src/billing/invoice.ts", "line": 3 }]
  }
}
```

```json
{
  "description": "a new violation shows in full once, then as a reminder",
  "steps": [
    { "hook": "pre-edit", "event": "pre-tool-use", "payload": { "session_id": "s1", "tool_name": "Write", "tool_input": { "file_path": "${PROJECT}/src/billing/invoice.ts", "content": "..." } }, "expect": { "pending": ["import-private"], "messageIncludes": "[NEW]" } },
    { "hook": "pre-tool", "event": "pre-tool-use", "files": { "src/billing/invoice.ts": "..." }, "payload": { "session_id": "s1", "tool_name": "Read" }, "expect": { "messageIncludes": "[OLD]" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `description` | one line that says what the case checks |
| `setup` | CLI argument lists run in the project copy first; each must exit with 0 |
| `delete` | paths removed after `after/` is applied |
| `claudeProjectDir` | `project` (default) or `parent`, the folder above the copy |
| `args`, `stdin` | command case: the arguments, `["check", "--json"]` by default, and the JSON on stdin; strings may hold `${PROJECT}` |
| `steps[]` | hook sequence: `hook` (the phase the step exercises), `event` (the exact event of `buckets hook --agent <agent> <event>`, as the adapter registers it, such as `pre-tool-use` or Gemini's `after-tool`), `agent` (default `claude`), `files` written before the step (`null` deletes), `payload` (harness JSON on stdin) and `expect`; every step shares one session state |
| `expect.exitCode` | the exact code, or `"nonzero"` |
| `expect.violations` | a set of `{ rule, file?, line?, project? }`, matched against `violationLocation`; `[]` means none |
| `expect.advice` | command cases with `--json`: a set of `{ advice, at?, project? }` matched against `CheckResult.advice`, `at` written as `formatConfigPath` writes it; `[]` means none |
| `expect.message`, `expect.messageIncludes` | the exact text the reader gets (check text output, or the hook's context, deny or block text), or strings it must contain |
| `expect.pending` | rule ids of the session's pending list after the step, compared sorted with repeats |
| `expect.decision` | hook steps only: `silent`, `context`, `deny` or `block`, read from the output as described below |
| `expect.stdoutJson`, `expect.stdoutEmpty`, `expect.stderrIncludes` | as in 1.x |
| `expect.filesExist`, `expect.filesMissing` | paths checked in the project copy after the run |
| `expect.idempotent` | the command runs twice with the same exit code and an unchanged tree |

## How the battery reads a hook step

The battery runs `buckets hook --agent <agent> <event>` with the step's `event`. The step's `hook` names the phase, which decides how a message reads below. An adapter may turn an event into another phase, such as Cursor's `post-tool-use` into `pre-edit` or `pre-tool`.

The plugin protocol of OpenCode, Pi and Amp (`cli/src/hooks/plugin-protocol.ts`) prints one JSON object such as `{"kind": "context", "text": "..."}`. When stdout is an object whose `kind` is `silent`, `context`, `deny` or `block`, the message is its `text` (empty when absent) and the decision is its `kind`.

For any other output, the message of a hook step is the first string found, at any depth of the JSON on stdout, under `additionalContext`, `additional_context` (Cursor), `contextModification` (Cline), `context` (Crush), `permissionDecisionReason`, `reason`, `followup_message`, `agent_message`, `user_message`, `errorMessage` (Cline's cancel), `message` or `systemMessage`, in that key order. If stdout is not JSON, the message is stdout itself. If stdout is empty and the hook exits with 2, the message is stderr.

The pending list comes from `.buckets/sessions/<session_id>[-<agent_id>].json` under the session root, with `session_id` and `agent_id` taken from the step's payload. Without a `session_id`, the battery reads the newest state file in that folder. No state file means an empty list, because the hook keeps state only once it has something to remember.

The decision is `deny` when the JSON holds `permissionDecision`, `permission` or `decision` equal to `deny`, or `cancel: true` (Cline). It is `block` when the JSON holds `decision: "block"` or a `followup_message`. Otherwise exit code 2 is `block` in `stop` and `subagent-stop` and `deny` in the other phases. Otherwise a non-empty message is `block` in the stop phases and `context` in the others, and no message is `silent`.

Every hook step fails, whatever its `expect`, when its stdout JSON holds `permissionDecision`, `permission` or `decision` equal to `allow` or `approve`, or `"continue": true`. An approval skips the user's permission prompt, so a hook never sends one.

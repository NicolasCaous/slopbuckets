// One plain sentence per id, for the generated reference. The ids come from the contract in cli/src/contract/:
// generate.mjs fails when an id is added to or removed from the contract without updating this file.

/** Why each rule exists. The contract's `detects` text says what the rule finds; this says why it matters. */
export const EXPLAIN_RULE = {
  'config-invalid': 'With a broken config no other rule can run, so the hook denies an edit that makes the config worse, and the edit never reaches the disk. A config that is already broken shows in the pending list.',
  'config-cycle': 'Code can only follow declared dependencies, so a cycle in the code needs a cycle in the config first, and this rule stops it there.',
  'dependency-undeclared': 'Every dependency between buckets has a written reason, and this is the one rule whose message shows both purposes, because it asks for an architecture decision.',
  'dependency-unused': 'A declared dependency that no import uses is a stale decision, and the next agent would read it as true.',
  'import-private': 'Other buckets reach a bucket only through its public file, so the rest of the bucket can change without breaking them.',
  'import-unresolved': 'An import that does not resolve drops out of every other rule, so the check reports it instead of passing with the dependency unseen.',
  'import-ignored': 'Ignored files sit outside the architecture, so code inside a bucket that depends on them hides a dependency the config does not show.',
  'import-dynamic': 'The check cannot follow a path computed at run time, so it reports the import instead of letting it pass unseen.',
  'import-namespace': 'export-unused needs to know which names each bucket uses, and a namespace import does not say.',
  'file-unowned': 'Every file is either in exactly one bucket or explicitly ignored, so no file falls outside the architecture by accident.',
  'file-overlap': 'A file in two buckets has no single owner, and the rules about its imports would contradict each other.',
  'glob-empty': 'A glob that matches nothing is usually a typo or a moved folder, and it leaves the config describing files that do not exist.',
  'public-missing': 'Other buckets import the public file, so it must exist and belong to the bucket that declares it.',
  'public-not-interface': 'The public file holds only named re-exports, so reading one file per bucket shows its whole interface.',
  'project-undeclared': 'Nested projects are listed explicitly, so a stray config never splits the project without a decision.',
  'export-unused': 'A name in the public file that no bucket imports widens the interface for nothing; tests and ignored files do not count as users.',
  'package-undeclared': 'Every external package a bucket uses has a written reason, so a new dependency on npm or on Node is a decision the config shows.',
  'package-unused': 'A declared package that no file of the bucket imports is a stale decision, and the next agent would read it as true.',
};

export const EXPLAIN_ENV = {
  'no-config': 'There is no `buckets.config.json` in the folder or its parents.',
  'config-newer': 'The config declares a newer format `version` than this slopbuckets reads. Run `buckets update`. The hooks show it once and never deny an edit because of it.',
  'no-typescript': 'Neither the `typescript` of the project nor the TypeScript 6 of slopbuckets loads, so the TypeScript adapter cannot resolve imports.',
  'no-tsconfig': 'The project has no `tsconfig.json` for module resolution.',
  'adapter-failed': 'The adapter failed, or speaks a different protocol version.',
};

export const EXPLAIN_PHASE = {
  'pre-edit': 'Runs before a write, edit or patch. It simulates the edit in memory and adds the pending list as context, or denies the edit when it makes the config worse.',
  'pre-tool': 'Runs before any other tool. It adds the current pending list as context without simulating anything, and marks the session as changed when the tool is a shell.',
  stop: 'Runs at the end of a turn, only when the session changed files. It runs the full check and blocks once with every violation in full.',
  'subagent-stop': 'Runs at the end of a subagent. It does the same as stop, and the block reason goes to the subagent.',
  'post-compact': 'Runs after a compaction. It clears the memory of what the session already showed, so every pending violation shows in full again.',
};

export const EXPLAIN_DECISION = {
  silent: 'No output and no tokens. The hook says nothing when nothing is pending.',
  context: 'The text joins the agent context and the tool runs. It never goes out with an "allow", because that would skip the user permission prompt.',
  deny: 'The edit does not run, and the text says why.',
  block: 'The turn does not end, and the text says why.',
  note: 'The turn ends, and the agent shows the text where it can without going on, such as the system message of Claude Code. An agent without such a place drops it. A stop answers it with the advice on reasons the session wrote.',
};

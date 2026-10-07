// One plain sentence per id, for the generated reference. The ids themselves come from the code:
// generate.mjs fails when an id is added to or removed from the code without updating this file.

export const RULE_GROUPS = [
  ['config-', 'Config'],
  ['project-', 'Project settings and nested projects'],
  ['folder-', 'Folders'],
  ['dmz-', 'DMZ files'],
  ['import-', 'Imports'],
  ['graph-', 'Bucket graph'],
  ['access-', 'Access rules'],
  ['link-', 'Links'],
];

export const EXPLAIN_RULE = {
  'config-invalid': '`buckets.config.json` is not valid JSON, a field breaks the schema, or the alias is also the alias of an enclosing project. Also `buckets.links.json` when it cannot be read or registers a link outside a bucket.',
  'project-config': 'The adapter found a project setting the check needs that is missing or wrong: the alias in `tsconfig.json`, `noUnusedLocals`, a build that does not cover the root bucket folder, a build that reaches a nested project, or a linked project the adapter cannot read.',
  'folder-loose-file': 'A file sits directly in a bucket folder. Every file goes in `_/` or in `dmz/`.',
  'folder-max-depth': 'A bucket is deeper than `maxDepth`. The root bucket is depth 0.',
  'folder-missing-code': 'A bucket has no `_/` folder, or the root bucket folder does not exist.',
  'folder-unexpected-dmz': 'A bucket without child buckets has a `dmz/` folder.',
  'folder-invalid-name': 'A child bucket folder has a name that starts with `.`.',
  'folder-symlink': 'A symbolic link or junction sits anywhere inside the root bucket folder.',
  'dmz-path': 'A DMZ file is not at `dmz/<provider>/<consumer>`, names a provider or consumer that does not exist, or has the wrong extension. Also a folder of declarations that an older slopbuckets version generated next to a `.external.ts` file: nothing reads it now, and the message asks to delete it.',
  'dmz-syntax': 'A DMZ file contains something other than `export { name } from` and `export type { Name } from` statements.',
  'dmz-target': 'A re-export points at a file this DMZ file may not re-export from.',
  'dmz-orphan': 'A DMZ symbol that no `_/` code uses, directly or through another DMZ, or an empty DMZ file.',
  'import-relative': 'An import with a relative path. Every internal import uses the alias, even inside the same `_/`.',
  'import-dynamic': 'A dynamic `import()` or a `require()`.',
  'import-unresolved': 'An import the adapter could not resolve to a file, package or built-in module.',
  'import-forbidden': 'An internal import outside what the bucket may import.',
  'import-namespace-dmz': 'An `import * as` of a DMZ file.',
  'import-undeclared-package': 'An import of a package that is not in `package.json`.',
  'import-global': 'A file in `_/` shares code without an import: a file that is not a module, `declare global`, `export as namespace` or a `/// <reference>`.',
  'graph-cycle': 'The bucket graph has a cycle. The check reports it once for each file that adds an edge of the cycle.',
  'access-denied': 'Code in one bucket uses code that originates in another bucket, and the `access` lines of `buckets.config.json` forbid that edge: the most specific line that matches it is a deny line, or no line matches and `access.default` is `"deny"`. The check reports it on the import line, after following the DMZ chain to the bucket that declares the symbol. It also reports it on the export line of a DMZ file when no bucket that may import that file may use the symbol. The message names the deciding line. `buckets.config.json` belongs to a human, so the agent never edits it: it removes the dependency, or stops and asks the human for the `access` line that allows it, written out in full.',
  'access-ambiguous': 'An allow line and a deny line both match an edge, and neither is at least as specific as the other on both sides, so the check cannot tell which one decides. Also a DMZ re-export that no bucket allowed to import the DMZ file may clearly use. The message names both lines. A human settles it by adding a line that is at least as specific as both on both sides, usually one that names both buckets, such as `root/teams/search -> root/sql`, in the list that should win. The agent stops and asks the human for that line, or removes the dependency.',
  'access-unknown-bucket': 'A side of an `access` line names a bucket without `*` or `{`, and no bucket has that path, so the line matches nothing. It usually follows a bucket folder that was renamed, moved or deleted, or a typo. Bucket paths start with the `root` folder of the config, such as `root/billing`. The check reports it on `buckets.config.json`. If the agent moved the bucket, it moves it back. Otherwise a human fixes the line. A pattern with wildcards that matches nothing is not an error.',
  'project-misplaced': "A `buckets.config.json` sits inside the root bucket folder somewhere other than a subfolder of a bucket's `_/`. Nested projects may live only there.",
  'link-missing': 'A link registered in `buckets.links.json` is not on disk, its target is gone, or a file sits where the link folder should be. `buckets link sync` recreates it.',
  'link-forbidden-import': 'Code, or a DMZ re-export, reaches a file of a linked project other than its published `.external.ts` files.',
  'link-missing-dependency': 'A file of a linked project imports a package that does not resolve where a tool looks for it: from the link path for type checking, or from the real path at runtime. The message says which side lacks it.',
};

export const EXPLAIN_LOCK = {
  'lock-missing': '`buckets.lock.json` does not exist yet, or cannot be read.',
  'bucket-added': 'A bucket folder exists that the lock does not have.',
  'bucket-removed': 'A bucket in the lock no longer exists.',
  'config-changed': 'A value in `buckets.config.json` changed. The message, `buckets refresh` and `buckets refresh --web` list each `access` line added or removed and every other key with its old and new value. When the lock is older than version 4, they show the current values only, because that lock kept only a hash.',
  'dmz-added': 'A DMZ file exists that the lock does not have.',
  'dmz-removed': 'A DMZ file in the lock was deleted.',
  'dmz-changed': 'The text of a DMZ file changed. Line endings and a leading byte order mark do not count.',
  'symbol-added': 'A DMZ file re-exports a symbol the lock does not have.',
  'symbol-removed': 'A DMZ file no longer re-exports a symbol the lock has.',
  'signature-changed': 'The type signature of a re-exported symbol changed, because its declaration in `_/` was edited.',
  'project-added': 'A nested project exists that the lock does not list.',
  'project-removed': 'A nested project in the lock no longer exists.',
  'link-added': 'A link in `buckets.links.json` is not in the lock.',
  'link-removed': 'A link in the lock is no longer in `buckets.links.json`.',
  'link-changed': 'A link changed its origin, mode or alias, or a symbol that the origin publishes in its `.external.ts` files was added, removed or changed its signature. A change inside the origin that keeps the published signatures is not a difference.',
  'link-drift': "A file of a copy differs from its origin, or the origin's `.external.ts` files now reach a file the copy lacks or no longer reach one it has. `buckets link update` copies the origin again.",
};

export const EXPLAIN_ENV = {
  'no-config': 'There is no `buckets.config.json` in the folder or its parents.',
  'cli-version': 'The installed CLI version differs from the one recorded in the lock.',
  'adapter-version': 'The adapter version differs from the one recorded in the lock.',
  'no-typescript': 'The project has no `typescript` package for the TypeScript adapter to load.',
  'no-tsconfig': 'The project has no `tsconfig.json` in its own folder. A nested project needs its own, because slopbuckets never uses the one of an enclosing project.',
  'adapter-failed': 'The adapter failed, or speaks a different protocol version.',
};

export const EXPLAIN_IMPORT_KIND = {
  internal: ['Import through the alias.', 'The resolved file.'],
  relative: ['Import with a relative path.', 'The text of the import.'],
  package: ['External package.', 'The package name.'],
  builtin: ['Node built-in module.', 'The module name.'],
  dynamic: ['`import()` or `require()`.', 'The text of the import, or `null` when it is not a fixed string.'],
  unresolved: ['The adapter could not classify it.', 'The text of the import.'],
};

export const EXPLAIN_HOOK = {
  PreToolUse: 'Denies any write to `buckets.lock.json` or `buckets.config.json`, under any name, any shell command that mentions either file, and any `buckets refresh` other than exactly `buckets refresh --web`, which may run in the background with its output redirected.',
  PostToolUse: 'Checks the file the agent just edited, in its nearest project, and reports a broken rule right away.',
  Stop: 'Runs the full check, nested projects included, before the agent ends its turn.',
  SubagentStop: 'Runs the full check, nested projects included, before a subagent hands back its work.',
};

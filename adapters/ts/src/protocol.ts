// Types for the protocol between the CLI and a language adapter.
// Every request and response carries the protocol version in `abi`.

export const ABI_VERSION = 1;

export interface BucketsConfig {
  root: string;
  alias: string;
  maxDepth: number;
}

export interface InfoResponse {
  abi: number;
  name: string;
  version: string;
  extensions: string[];
  dmzExtension: string;
}

export interface InitRequest {
  abi: number;
  config: BucketsConfig;
  /**
   * Folders of the projects nested in this one, relative to the project, such as `root/log/_/engine`. Optional.
   * A nested project has its own build settings, so the adapter keeps each folder out of this project's build: the
   * TypeScript adapter adds it to `exclude` of the tsconfig when `include` reaches it. When the file cannot be edited
   * safely, the change description says what to add by hand.
   */
  nestedProjects?: string[];
}

export interface InitResponse {
  abi: number;
  /**
   * One entry per file that was written or needs a hand edit. `written: false` marks a file that was left as it was:
   * the description then starts with "not changed, because" or "no change written, but" and says what to change by
   * hand. Without `written`, the file was written.
   */
  changed: { file: string; description: string; written?: boolean }[];
}

export interface AnalyzeRequest {
  abi: number;
  config: BucketsConfig;
  files: { dmz: string[]; code: string[] };
  /**
   * Folders of the projects nested in this one, relative to the project, as the CLI's scan finds them. Optional.
   * The adapter reports a problem in `config` when this project's build settings still reach one of them: for
   * TypeScript, when the effective `include` or `files` of the tsconfig cover the folder and `exclude` does not
   * leave it out.
   */
  nestedProjects?: string[];
  /**
   * Source-code links of the project. `path` is the link folder relative to the project (`<bucket>/_/links/<name>`),
   * a junction or symlink to the origin's root folder or a plain copy of its source files. `alias` is the origin's
   * alias. The adapter maps `<alias>/*` to `<path>/*` for this analysis and describes each link in
   * `AnalyzeResponse.links`. Files inside a link are not analyzed as code, even when listed in `files.code`.
   */
  links?: LinkRequest[];
}

export interface LinkRequest {
  path: string;
  alias: string;
}

export type ImportKind = 'internal' | 'relative' | 'package' | 'builtin' | 'dynamic' | 'unresolved';

export interface ImportEntry {
  kind: ImportKind;
  target: string | null;
  line: number;
  names?: string[];
  declared?: boolean;
  /** True for `export ... from` inside code. A re-export does not count as a use of a DMZ symbol. */
  reexport?: boolean;
  /** Names from `names` that the file never references. They do not count as a use of a DMZ symbol. */
  unusedNames?: string[];
  /**
   * Names from `names` that the file exports again: `export { a as b } from`, or `import { a }` followed by
   * `export { a as b }` or `export default a`. `name` is the imported name and `as` the exported one. `name: "*"`
   * passes the whole module on (`export * as ns from`); `{ name: "*", as: "*" }` is `export * from`. The CLI counts
   * such a name as used when another file of the same bucket imports it from this file and uses it.
   */
  reexportedAs?: { name: string; as: string }[];
  /**
   * True when the whole statement is type-only: `import type { A } from`, `import type A from`,
   * `export type { A } from`. An import whose every element has an inline `type` modifier (`import { type A }`)
   * is not type-only, because `verbatimModuleSyntax` keeps it as a runtime import. Absent when the adapter does not
   * report it.
   */
  typeOnly?: boolean;
}

export interface DmzExport {
  name: string;
  typeOnly: boolean;
  from: string;
  signature: string;
  line: number;
}

export interface AnalyzeResponse {
  abi: number;
  config: { file: string; message: string; line?: number }[];
  dmz: Record<string, { exports: DmzExport[]; violations: { line: number; message: string }[] }>;
  /**
   * `globals` lists ways a file shares code without imports: not a module, `declare global`, `export as namespace`,
   * triple-slash references. Each message says how to fix that case.
   */
  code: Record<string, { imports: ImportEntry[]; globals?: { line: number; message: string }[] }>;
  /** Tools whose version can change signature hashes, such as "typescript@5.9.3". The CLI stores it in the lock. */
  toolchain?: string;
  /**
   * Every file the analysis read: the tsconfig chain (references and `extends`), package.json files, and every
   * source file of the program, `.d.ts` files outside the root folder, type packages and linked files included, plus
   * the `.external.ts` and node_modules paths probed for links, which may not exist. Paths inside the project are
   * project-relative with `/`; others are absolute. The CLI keys its analysis cache on these files and
   * does not cache an answer without this list.
   */
  inputs?: string[];
  /**
   * One report per requested link, keyed by the link path as given in the request. Present when the request has
   * `links`. Every file path in it is project-relative and goes through the link (`<link path>/<path in the origin>`).
   */
  links?: Record<string, LinkReport>;
}

export interface LinkReport {
  /** Every symbol that a `dmz/**\/.external.ts` inside the link publishes, in file order. */
  exports: LinkExport[];
  /**
   * Every bare package specifier that a linked file reachable from the `.external.ts` files imports. Node builtins
   * are left out. See `LinkDependency` for where each one must resolve.
   */
  dependencies: LinkDependency[];
  /** What kept the adapter from reading the link: a missing folder, no `.external.ts`, a parse error, a broken re-export. */
  problems: LinkProblem[];
}

export interface LinkExport {
  /** The `.external.ts` that publishes the symbol. */
  file: string;
  name: string;
  typeOnly: boolean;
  /** Same hashing as DMZ symbols. Equal for a junction and a copy of the same origin, wherever the link lives. */
  signature: string;
  line: number;
}

/**
 * A package that a linked file imports. In a link to the origin's folder (a junction or symlink), two tools look for
 * the package in different places. The consumer's type checker reads the file through the link path and looks up
 * packages from the consumer's folders, so the consumer needs the package or its `@types` package. Node and bundlers
 * follow the link to the real path and look up packages from the origin's folders, so the origin needs the package
 * itself. In a copy, the link path is the real path, so both lookups start in the consumer.
 */
export interface LinkDependency {
  package: string;
  /** The linked file that imports the package, project-relative through the link. */
  from: string;
  /** True when the package resolves both for type checking and at runtime. */
  resolved: boolean;
  /**
   * True when Node-style lookup from the link path of `from` finds the package or its `@types` package, as the
   * consumer's type checker needs. Optional: an adapter that does not report it leaves the CLI with `resolved` only.
   */
  resolvedForTypes?: boolean;
  /**
   * True when Node-style lookup from the real path of `from` finds the package, as Node and bundlers need, or when
   * every import of the package in `from` is type-only (erased before runtime). Optional, like `resolvedForTypes`.
   */
  resolvedAtRuntime?: boolean;
}

export interface LinkProblem {
  file?: string;
  line?: number;
  message: string;
}

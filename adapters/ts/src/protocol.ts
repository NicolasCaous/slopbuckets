// Protocol between the CLI and a language adapter, ABI 2 (docs/guide/adapters.md).
// Every path is relative to the project folder with `/`, unless it leaves the project: then it starts with `../`.

export const ADAPTER_ABI = 2;

export interface InfoResponse {
  abi: typeof ADAPTER_ABI;
  name: string;
  version: string;
  /** File extensions the adapter reads, with the dot, such as ['.ts', '.tsx']. */
  extensions: string[];
}

export interface AnalyzeRequest {
  abi: typeof ADAPTER_ABI;
  /** Files to analyze. */
  files: string[];
  /**
   * Files among `files` whose `exports` the adapter also returns. The CLI names every file it analyzes: it keeps the
   * exports of the public files, and of the other files the names exported as types only, so that a re-export of a
   * private import can use `export type`.
   */
  publicFiles?: string[];
  /** Text that replaces a file on disk, for the edit a pre-edit hook simulates. A path here may not exist on disk yet. */
  contents?: Record<string, string>;
}

export type ImportTarget =
  /** A file, relative to the project. */
  | { file: string }
  /** A package from node_modules, by package name, such as 'lodash' or '@scope/pkg'. */
  | { package: string }
  /** A Node built-in module, such as 'node:fs' or 'fs'. */
  | { builtin: string }
  /**
   * The specifier does not resolve, or is not a string literal. `unresolved` says what kind of specifier it was:
   * relative ('./x', '../x'), paths (it matches the tsconfig paths pattern `pattern` of the file's nearest tsconfig, or
   * without `pattern` its first segment is a folder under baseUrl and no installed package), workspace (a package
   * name whose node_modules link has its real path inside the project), package (any other bare name: an npm package
   * that is not installed, whose packages key the engine takes from the specifier), other (empty, absolute, a
   * package.json `#` import, not a string literal, or a file on disk that is no listed source file, such as
   * './App.css'). The engine reports import-unresolved for relative, paths and workspace.
   */
  | { unresolved: 'relative' | 'paths' | 'workspace' | 'package' | 'other'; pattern?: string };

export interface ImportedName {
  /** The name as exported by the target, `default` for a default import. */
  name: string;
  /** `import type { A }`, `import { type A }`, `export type { A } from`. */
  typeOnly: boolean;
}

export interface ImportRecord {
  /** The specifier as written, or the source text of the argument when it is not a string literal. */
  specifier: string;
  /** 1-based line of the statement. */
  line: number;
  /** static: import and export ... from. dynamic: import(). require: require(). */
  kind: 'static' | 'dynamic' | 'require';
  /** False when import() or require() gets something other than a string literal. Always true for static. */
  literal: boolean;
  /** True for `export ... from`. */
  reexport: boolean;
  /**
   * The names used. `*` for import * as x, export * from, and import() or require() without destructuring.
   * [] for a side-effect import such as import './polyfill'.
   */
  names: ImportedName[] | '*';
  target: ImportTarget;
}

/** `export { a, b as c } from './x'` or `export type { A } from './x'`. */
export interface NamedReexport {
  line: number;
  specifier: string;
  target: ImportTarget;
  /** `name` is the name in the source module, `as` the exported name (equal when not renamed). */
  names: { name: string; as: string; typeOnly: boolean }[];
}

/** `export * from './x'` or `export * as ns from './x'`. */
export interface StarReexport {
  line: number;
  specifier: string;
  target: ImportTarget;
  /** The namespace name for `export * as ns`, null for `export *`. */
  as: string | null;
}

/** Returned only for files in `publicFiles`. `typeOnly` is true for an interface, a type alias and `export type`. */
export interface PublicExports {
  /** Every exported name with its line, `default` included, whatever the statement. */
  names: { name: string; line: number; typeOnly: boolean }[];
  reexports: NamedReexport[];
  stars: StarReexport[];
  /** Lines that hold anything other than named re-exports, comments and blank lines, in order. */
  codeLines: number[];
}

export interface FileAnalysis {
  /** Every import, re-export, import() and require() of the file, in source order. */
  imports: ImportRecord[];
  exports?: PublicExports;
}

/** A file that affects module resolution, such as a tsconfig.json in the extends chain or a package.json. */
export interface ResolutionInput {
  path: string;
  /** Opaque content hash. The CLI drops cached resolutions when any hash changes. */
  hash: string;
}

export type AnalyzeResponse =
  | {
      abi: typeof ADAPTER_ABI;
      /** One entry per requested file that could be read. A file that cannot be read is left out. */
      files: Record<string, FileAnalysis>;
      inputs: ResolutionInput[];
    }
  | {
      abi: typeof ADAPTER_ABI;
      /** The adapter could not analyze the project. The CLI reports it as an environment error, exit code 3. */
      error: { code: 'no-typescript' | 'no-tsconfig' | 'adapter-failed'; message: string };
    };

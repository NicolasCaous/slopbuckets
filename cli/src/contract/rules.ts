// Rule ids, the warn or interrupt matrix and the exit codes of slopbuckets 2.0. docs/reference/rules.md is generated
// from this file, and docs/guide/hooks.md, "Warn or interrupt", explains the matrix.

export const RULE_IDS = [
  'config-invalid',
  'config-cycle',
  'dependency-undeclared',
  'dependency-unused',
  'import-private',
  'import-unresolved',
  'import-ignored',
  'import-dynamic',
  'import-namespace',
  'file-unowned',
  'file-overlap',
  'glob-empty',
  'public-missing',
  'public-not-interface',
  'project-undeclared',
  'export-unused',
  'package-undeclared',
  'package-unused',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** `warn` adds the pending list as context and lets the tool run. `interrupt` denies the edit or blocks the stop. */
export type HookBehavior = 'warn' | 'interrupt';

export interface RuleInfo {
  /** Behavior in the pre-edit and pre-tool phases. */
  preTool: HookBehavior;
  /** Behavior in the stop and subagent-stop phases. Always `interrupt`: after the turn ends nobody reads a warning. */
  stop: 'interrupt';
  /** One sentence that says what the rule detects, for docs and the inspect page. */
  detects: string;
}

export const RULES: Readonly<Record<RuleId, RuleInfo>> = {
  'config-invalid': {
    preTool: 'interrupt',
    stop: 'interrupt',
    detects:
      'buckets.config.json is not valid JSON, misses a required field, has an empty reason, names a bucket that does not exist, or names a package by a subpath.',
  },
  'config-cycle': { preTool: 'warn', stop: 'interrupt', detects: 'The dependsOn graph of the config has a cycle.' },
  'dependency-undeclared': { preTool: 'warn', stop: 'interrupt', detects: 'A file of bucket A imports bucket B, and A.dependsOn does not list B.' },
  'dependency-unused': { preTool: 'warn', stop: 'interrupt', detects: 'A.dependsOn lists B, and no file of A imports B.' },
  'import-private': {
    preTool: 'warn',
    stop: 'interrupt',
    detects:
      'A file of bucket A imports a file of bucket B that B.public does not list, or any file of B when B.public is null, and A declares B in dependsOn. Without that declaration, dependency-undeclared reports these imports.',
  },
  'import-unresolved': {
    preTool: 'warn',
    stop: 'interrupt',
    detects: 'A relative import, an import that matches a tsconfig paths pattern, or an import of a workspace package does not resolve to a file.',
  },
  'import-ignored': { preTool: 'warn', stop: 'interrupt', detects: 'A file of a bucket imports a file that ignore lists.' },
  'import-dynamic': {
    preTool: 'warn',
    stop: 'interrupt',
    detects: 'import() or require() gets an argument that is not a string literal, so the check cannot see the target.',
  },
  'import-namespace': {
    preTool: 'warn',
    stop: 'interrupt',
    detects: 'import * as x, export * from, or import() without destructuring points to another bucket and does not name what it uses.',
  },
  'file-unowned': { preTool: 'warn', stop: 'interrupt', detects: 'A file is in no bucket and not in ignore.' },
  'file-overlap': { preTool: 'warn', stop: 'interrupt', detects: 'A file is in two or more buckets.' },
  'glob-empty': { preTool: 'warn', stop: 'interrupt', detects: 'A glob of files or ignore, or a path of projects, matches nothing.' },
  'public-missing': {
    preTool: 'warn',
    stop: 'interrupt',
    detects: 'A file that public lists does not exist or does not belong to the bucket.',
  },
  'public-not-interface': {
    preTool: 'warn',
    stop: 'interrupt',
    detects: 'A public file has code, uses export *, or re-exports from another bucket.',
  },
  'project-undeclared': { preTool: 'warn', stop: 'interrupt', detects: 'A nested buckets.config.json is not listed in projects.' },
  'export-unused': {
    preTool: 'warn',
    stop: 'interrupt',
    detects: 'A name exported by a public file of a bucket is not imported by any other bucket.',
  },
  'package-undeclared': {
    preTool: 'warn',
    stop: 'interrupt',
    detects: 'A file of a bucket imports an npm package or a Node built-in that the packages of the bucket do not list.',
  },
  'package-unused': { preTool: 'warn', stop: 'interrupt', detects: 'The packages of a bucket list a package that no file of the bucket imports.' },
};

/**
 * Advice: notes about the quality of the config. They show only in the stop text (when the stop blocks for a
 * violation anyway) and in `buckets check`, under their own heading. They never enter the pending list, never count
 * for the exit code and never make the stop block.
 */
export const ADVICE_IDS = ['reason-generic', 'ignore-large'] as const;
export type AdviceId = (typeof ADVICE_IDS)[number];

export const ADVICE: Readonly<Record<AdviceId, { detects: string }>> = {
  'reason-generic': {
    detects:
      'A purpose or reason (dependsOn, packages, external) has fewer than three words, or is only a bucket name and a generic verb such as uses, needs, calls, imports or depends on. A purpose also gets it when it holds only bucket names and filler words such as does, job, stuff, things or handles.',
  },
  'ignore-large': { detects: 'An ignore glob matches more than 20% of the source files, not counting tests, scripts, fixtures and examples, which then fall outside every rule.' },
};

/** reason-generic: a purpose or reason with fewer words than this is short. */
export const REASON_MIN_WORDS = 3;
/** reason-generic: the verbs that, with only bucket names around them, make a reason generic. */
export const GENERIC_VERBS = ['uses', 'use', 'needs', 'need', 'calls', 'call', 'imports', 'import', 'depends on', 'depend on'] as const;
/** ignore-large: an ignore glob that matches more than this share of the source files. */
export const IGNORE_LARGE_SHARE = 0.2;

const FILLER = new Set(['a', 'an', 'and', 'the', 'it', 'on', 'to', 'for', ...GENERIC_VERBS.flatMap((v) => v.split(' '))]);
const NAME_SETS = new WeakMap<readonly string[], Set<string>>();

/**
 * Why a purpose or reason gets reason-generic advice, or null when it gets none. `names` are the bucket names of
 * the config. Words are runs of letters, digits, `-`, `_`, `.`, `/`, `@` and `:`. The text is generic when, after
 * removing bucket names, the generic verbs and the words a, an, and, the, it, on, to and for, no word is left. Otherwise
 * it is short when it has fewer than REASON_MIN_WORDS words.
 */
export function reasonAdvice(text: string, names: readonly string[]): 'generic' | 'short' | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}@:/._-]+/gu) ?? [];
  // A config can hold 18,000 reasons over 500 names: the set of names is built once per list.
  let known = NAME_SETS.get(names);
  if (known === undefined) NAME_SETS.set(names, (known = new Set(names)));
  const rest = words.filter((w) => !FILLER.has(w) && !known.has(w.replace(/[.:]+$/, '')));
  if (rest.length === 0) return 'generic';
  return words.length < REASON_MIN_WORDS ? 'short' : null;
}

/**
 * Exit codes of every command. 2 is retired so that no old script reads it with its 1.x meaning. `usage` (64, EX_USAGE
 * of sysexits) is a command line the CLI does not understand, such as an unknown option, so that a typo in CI does not
 * read as "found violations".
 */
export const EXIT_CODES = { ok: 0, violations: 1, environment: 3, usage: 64 } as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Errors that stop a project from being checked at all. They give exit code 3. `config-newer`: the config declares a
 * version this CLI does not read (configVersionStatus in config.ts says `newer`); the message comes from
 * configNewerMessage in messages.ts. The hooks never deny an edit or block a stop for config-newer: they show it once
 * per session as context.
 */
export const ENVIRONMENT_CODES = ['no-config', 'config-newer', 'no-typescript', 'no-tsconfig', 'adapter-failed'] as const;
export type EnvironmentCode = (typeof ENVIRONMENT_CODES)[number];

/** File name of the config in every project. */
export const CONFIG_FILE = 'buckets.config.json';

/** The config version this CLI writes and reads (config.ts, configVersionStatus). */
export const CONFIG_VERSION = '2.0';

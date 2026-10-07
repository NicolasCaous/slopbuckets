// Access lines of buckets.config.json ("A -> B"). Each side is a glob over bucket paths (bucket-glob.ts).
import { compiler, decide, NO_SCRIPTS, matchesBucket, parsePattern, splitAtArrows, type BucketPattern, type Decision, type GlobLine, type LineLists, type ScriptValues } from './bucket-glob.js';

/** The `access` key of the resolved config. Lines are in canonical form, `A -> B`. */
export type AccessConfig = LineLists;

/** A parsed access line: code in a bucket that `from` matches uses code that originates in a bucket that `to` matches. */
export interface AccessLine extends GlobLine {
  /** Canonical form, `A -> B` with one space on each side of the arrow. */
  text: string;
  from: BucketPattern;
  to: BucketPattern;
}

/**
 * Parses `A -> B`. Returns the reason when the line is malformed. `scripts` gives the values of the scripts that the
 * line names in backticks; without it, the line is only checked for syntax (see `parsePattern`).
 */
export function parseAccessLine(text: string, scripts?: ScriptValues): { line: AccessLine } | { error: string } {
  let sides = splitAtArrows(text);
  // A group without its closer hides the arrow. A plain split then lets the pattern parser name the unclosed group.
  if (sides.length !== 2 && text.split('->').length === 2) sides = text.split('->');
  if (sides.length !== 2) {
    return { error: `"${text}" must contain exactly one "->", as in "root/api/** -> root/log".` };
  }
  const from = parsePattern(sides[0]!.trim(), scripts);
  if ('error' in from) return { error: `The left side of "${text}" ${from.error}` };
  const to = parsePattern(sides[1]!.trim(), scripts);
  if ('error' in to) return { error: `The right side of "${text}" ${to.error}` };
  return { line: { text: `${from.pattern.text} -> ${to.pattern.text}`, from: from.pattern, to: to.pattern, patterns: [from.pattern, to.pattern] } };
}

/** The outcome for one edge. See `Decision`. */
export type AccessDecision = Decision;

const compile = compiler(parseAccessLine, 'access');

/**
 * Decides whether code in the bucket `from` may use code that originates in the bucket `to`. A line matches the edge
 * when its left side matches `from` and its right side matches `to`. One line dominates another when it is at least as
 * specific on both sides and more specific on one; `decide` explains the rest. `scripts` holds the values of every
 * script the lines name.
 */
export function evaluateAccess(access: AccessConfig, from: string, to: string, scripts: ScriptValues = NO_SCRIPTS): AccessDecision {
  return decide(access.default, compile(access, scripts), (line) => matchesBucket(line.from, from) && matchesBucket(line.to, to));
}

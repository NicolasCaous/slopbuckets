// Layout lines of buckets.config.json: globs over bucket paths that say which bucket folders may exist. The lines
// follow the same rules as access lines (bucket-glob.ts), with one pattern each instead of two.
import { compiler, decide, matchesBelow, matchesBucket, parsePattern, splitAtArrows, type Decision, type GlobLine, type LineLists } from './bucket-glob.js';

/** The `layout` key of the resolved config. Lines are in canonical form, without the spaces around them. */
export type LayoutConfig = LineLists;

/** Parses one layout line, such as `root/gpu/*`. Returns the reason when the line is malformed. */
export function parseLayoutLine(text: string): { line: GlobLine } | { error: string } {
  const trimmed = text.trim();
  if (splitAtArrows(trimmed).length > 1) {
    return { error: `"${text}" contains "->". A layout line is one bucket path glob, such as "root/*/*". Lines with "->" belong in "access".` };
  }
  const parsed = parsePattern(trimmed);
  if ('error' in parsed) return { error: `"${text}" ${parsed.error}` };
  return { line: { text: parsed.pattern.text, patterns: [parsed.pattern] } };
}

/**
 * The outcome for one bucket. Besides the outcomes of `Decision`, a bucket that no line matches under
 * `"default": "deny"` passes as `below` when no deny line matches it and an allow line can match a bucket below it.
 * `line` then names that allow line.
 */
export type LayoutDecision = Decision | { allowed: true; by: 'below'; line: string };

const compile = compiler(parseLayoutLine, 'layout');

/**
 * Decides whether the bucket folder `bucket` may exist. The most specific matching line decides, as for access. A
 * bucket that the lines do not allow still passes when no deny line matches it and some allow line can match one of
 * its descendants, so `"allow": ["root/gpu/*"]` lets `root` and `root/gpu` exist too.
 */
export function evaluateLayout(layout: LayoutConfig, bucket: string): LayoutDecision {
  const lines = compile(layout);
  const decision = decide(layout.default, lines, (line) => matchesBucket(line.patterns[0]!, bucket));
  // `default` decides only when no line matches the bucket, so no deny line matches it either.
  if (decision.allowed || decision.by !== 'default') return decision;
  const below = lines.allow
    .filter((line) => matchesBelow(line.patterns[0]!, bucket))
    .map((line) => line.text)
    .sort()[0];
  return below === undefined ? decision : { allowed: true, by: 'below', line: below };
}

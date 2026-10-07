// Globs over bucket paths, as the lock lists them, such as `root/billing`, and the "most specific line decides" rule
// that the `access` and `layout` keys of buckets.config.json share. Hand written so the CLI has no runtime dependency.

/** A key of the config made of an outcome for what no line matches and two lists of lines: `access` and `layout`. */
export interface LineLists {
  default: 'allow' | 'deny';
  allow: string[];
  deny: string[];
}

/** A glob over bucket paths. */
export interface BucketPattern {
  /** The pattern as written, without the spaces around it. */
  text: string;
  /** True when the pattern has no `*` and no `{`, so it names exactly one bucket. */
  literal: boolean;
  /** One entry per `/` segment: `**`, or a regular expression for the whole segment. */
  segments: Array<'**' | RegExp>;
  /**
   * The specificity tuple: the number of literal segments, of segments with `*` or `{}` mixed with other text (such as
   * `team-*` or `{api,web}`), of segments that are exactly `*`, and minus the number of `**` segments.
   */
  specificity: [number, number, number, number];
}

/** A parsed line of `allow` or `deny`: its canonical text and its patterns, one for `layout`, two for `access`. */
export interface GlobLine {
  text: string;
  patterns: BucketPattern[];
}

/**
 * Parses one pattern. `**` as a whole segment matches zero or more bucket names, `*` matches any characters inside a
 * segment, `{a,b}` matches one of the alternatives, and every other character is literal except `|`, which is an
 * error. A segment can hold several brace groups, such as `{a,b}+{c,d}`.
 */
export function parsePattern(text: string): { pattern: BucketPattern } | { error: string } {
  if (text === '') return { error: 'is empty. Write a bucket path such as "root/billing", or "**" for every bucket.' };
  const segments: BucketPattern['segments'] = [];
  const specificity: BucketPattern['specificity'] = [0, 0, 0, 0];
  for (const segment of text.split('/')) {
    if (segment === '') return { error: `has an empty segment in "${text}". Remove the extra "/".` };
    if (segment === '**') {
      segments.push('**');
      specificity[3]--;
      continue;
    }
    const source = segmentSource(segment);
    if (typeof source !== 'string') return source;
    segments.push(new RegExp(`^${source}$`, 'u'));
    specificity[segment === '*' ? 2 : /[*{]/.test(segment) ? 1 : 0]++;
  }
  return { pattern: { text, literal: !/[*{]/.test(text), segments, specificity } };
}

function segmentSource(segment: string): string | { error: string } {
  let source = '';
  let inBraces = false;
  for (const char of segment) {
    // Users write {a|b} for alternatives, and Windows forbids | in a folder name, so it is never a literal.
    if (char === '|') return { error: `has a "|" in "${segment}". Separate alternatives with a comma, as in "{A,B,C}".` };
    if (char === '*') source += '.*';
    else if (char === '{') {
      if (inBraces) return { error: `nests "{" in "${segment}". Alternatives cannot contain other alternatives.` };
      inBraces = true;
      source += '(?:';
    } else if (char === '}') {
      if (!inBraces) return { error: `has a "}" without a "{" in "${segment}".` };
      inBraces = false;
      source += ')';
    } else if (char === ',' && inBraces) source += '|';
    else source += char.replace(/[\\^$.|?+()[\]{}]/g, '\\$&');
  }
  if (inBraces) return { error: `has a "{" without a "}" in "${segment}".` };
  return source;
}

/**
 * What is wrong with a pattern that starts with neither the root path nor `**`, or null. Every bucket path starts with
 * the root path, so such a pattern would match no bucket. The prefix is compared on whole segments.
 */
export function rootPrefixProblem(pattern: string, root: string): string | null {
  const segments = pattern.split('/');
  if (segments[0] === '**' || root.split('/').every((s, i) => segments[i] === s)) return null;
  return `must start with the root path "${root}" or with "**", because every bucket path starts with "${root}", such as "${root}/billing". If the root folder moved, write the new root path at the start of the line.`;
}

/** True when the pattern matches the bucket path, such as `root/billing/payments`. */
export function matchesBucket(pattern: BucketPattern, bucketPath: string): boolean {
  return matchSegments(pattern.segments, 0, bucketPath.split('/'), 0);
}

function matchSegments(pattern: BucketPattern['segments'], p: number, names: string[], n: number): boolean {
  if (p === pattern.length) return n === names.length;
  const segment = pattern[p]!;
  if (segment === '**') {
    for (let skip = n; skip <= names.length; skip++) {
      if (matchSegments(pattern, p + 1, names, skip)) return true;
    }
    return false;
  }
  return n < names.length && segment.test(names[n]!) && matchSegments(pattern, p + 1, names, n + 1);
}

/**
 * True when the pattern can match a bucket below `bucketPath`: a path that starts with its names and has more of them.
 * Once the pattern reaches a `**`, or still has segments after the last name, it can match some deeper path.
 */
export function matchesBelow(pattern: BucketPattern, bucketPath: string): boolean {
  const names = bucketPath.split('/');
  const segments = pattern.segments;
  for (let i = 0; ; i++) {
    if (i === names.length) return i < segments.length;
    if (i === segments.length) return false;
    const segment = segments[i]!;
    if (segment === '**') return true;
    if (!segment.test(names[i]!)) return false;
  }
}

/**
 * Compares two patterns: positive when `a` is more specific, negative when `b` is, 0 when they are equally specific.
 * The specificity tuples are compared left to right, so where a segment sits in the pattern does not matter.
 */
export function compareSpecificity(a: BucketPattern, b: BucketPattern): number {
  for (let i = 0; i < a.specificity.length; i++) {
    if (a.specificity[i] !== b.specificity[i]) return a.specificity[i]! - b.specificity[i]!;
  }
  return 0;
}

/** True when `a` is at least as specific as `b` on every pattern and more specific on at least one. */
function dominates(a: GlobLine, b: GlobLine): boolean {
  const order = a.patterns.map((pattern, i) => compareSpecificity(pattern, b.patterns[i]!));
  return order.every((o) => o >= 0) && order.some((o) => o > 0);
}

/**
 * The outcome for one case. `line` is the line that decided, absent when `default` decided. An ambiguous case fails,
 * and names the allow line and the deny line that match it with no line more specific than both.
 */
export type Decision =
  | { allowed: boolean; by: 'deny' | 'allow' | 'default'; line?: string }
  | { allowed: false; by: 'ambiguous'; allowLine: string; denyLine: string };

/**
 * Of the lines that `matches` accepts, a line that another matching line dominates drops out. When none is left,
 * `default` decides. When the lines left come from one list, that list decides and the first of them in plain string
 * order is named. When both lists still have a line, the case is ambiguous and fails.
 */
export function decide<L extends GlobLine>(fallback: LineLists['default'], lines: { allow: L[]; deny: L[] }, matches: (line: L) => boolean): Decision {
  const matching = [...lines.allow.filter(matches).map((line) => ({ line, list: 'allow' as const })), ...lines.deny.filter(matches).map((line) => ({ line, list: 'deny' as const }))];
  const left = matching.filter((m) => !matching.some((other) => dominates(other.line, m.line)));
  // The first line in plain string order, so the line a message names does not depend on the order in the file.
  const first = (list: 'allow' | 'deny'): string | undefined =>
    left
      .filter((m) => m.list === list)
      .map((m) => m.line.text)
      .sort()[0];
  const allow = first('allow');
  const deny = first('deny');
  if (allow !== undefined && deny !== undefined) return { allowed: false, by: 'ambiguous', allowLine: allow, denyLine: deny };
  if (allow !== undefined) return { allowed: true, by: 'allow', line: allow };
  if (deny !== undefined) return { allowed: false, by: 'deny', line: deny };
  return { allowed: fallback === 'allow', by: 'default' };
}

/**
 * Parses every line of `lists` once per config object. A resolved config holds only valid lines, so a parse error
 * here is a bug.
 */
export function compiler<L>(parse: (text: string) => { line: L } | { error: string }, key: string): (lists: LineLists) => { allow: L[]; deny: L[] } {
  const compiled = new WeakMap<LineLists, { allow: L[]; deny: L[] }>();
  return (lists) => {
    let lines = compiled.get(lists);
    if (lines === undefined) {
      const each = (list: string[]): L[] =>
        list.map((text) => {
          const result = parse(text);
          if ('error' in result) throw new Error(`Invalid ${key} line in a resolved config: ${result.error}`);
          return result.line;
        });
      lines = { allow: each(lists.allow), deny: each(lists.deny) };
      compiled.set(lists, lines);
    }
    return lines;
  };
}

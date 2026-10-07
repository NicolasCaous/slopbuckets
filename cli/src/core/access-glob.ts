// Access lines of buckets.config.json ("A -> B") and the globs on each side. A glob matches bucket paths as the
// lock lists them, such as `root/billing`. Hand written so the CLI has no runtime dependency.

/** The `access` key of the resolved config. Lines are in canonical form, `A -> B`. */
export interface AccessConfig {
  default: 'allow' | 'deny';
  allow: string[];
  deny: string[];
}

/** One side of an access line. */
export interface AccessPattern {
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

/** A parsed access line: code in a bucket that `from` matches uses code that originates in a bucket that `to` matches. */
export interface AccessLine {
  /** Canonical form, `A -> B` with one space on each side of the arrow. */
  text: string;
  from: AccessPattern;
  to: AccessPattern;
}

/** Parses `A -> B`. Returns the reason when the line is malformed. */
export function parseAccessLine(text: string): { line: AccessLine } | { error: string } {
  const sides = text.split('->');
  if (sides.length !== 2) {
    return { error: `"${text}" must contain exactly one "->", as in "root/api/** -> root/log".` };
  }
  const from = parsePattern(sides[0]!.trim());
  if ('error' in from) return { error: `The left side of "${text}" ${from.error}` };
  const to = parsePattern(sides[1]!.trim());
  if ('error' in to) return { error: `The right side of "${text}" ${to.error}` };
  return { line: { text: `${from.pattern.text} -> ${to.pattern.text}`, from: from.pattern, to: to.pattern } };
}

/**
 * Parses one side of a line. `**` as a whole segment matches zero or more bucket names, `*` matches any characters
 * inside a segment, `{a,b}` matches one of the alternatives, and every other character is literal.
 */
export function parsePattern(text: string): { pattern: AccessPattern } | { error: string } {
  if (text === '') return { error: 'is empty. Write a bucket path such as "root/billing", or "**" for every bucket.' };
  const segments: AccessPattern['segments'] = [];
  const specificity: AccessPattern['specificity'] = [0, 0, 0, 0];
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

/** True when the pattern matches the bucket path, such as `root/billing/payments`. */
export function matchesBucket(pattern: AccessPattern, bucketPath: string): boolean {
  return matchSegments(pattern.segments, 0, bucketPath.split('/'), 0);
}

function matchSegments(pattern: AccessPattern['segments'], p: number, names: string[], n: number): boolean {
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
 * The outcome for one edge. `line` is the access line that decided, absent when `default` decided. An ambiguous edge
 * fails, and names the allow line and the deny line that match it with no line more specific than both.
 */
export type AccessDecision =
  | { allowed: boolean; by: 'deny' | 'allow' | 'default'; line?: string }
  | { allowed: false; by: 'ambiguous'; allowLine: string; denyLine: string };

const compiled = new WeakMap<AccessConfig, { allow: AccessLine[]; deny: AccessLine[] }>();

function compile(access: AccessConfig): { allow: AccessLine[]; deny: AccessLine[] } {
  let lines = compiled.get(access);
  if (lines === undefined) {
    const parse = (list: string[]): AccessLine[] =>
      list.map((text) => {
        const result = parseAccessLine(text);
        if ('error' in result) throw new Error(`Invalid access line in a resolved config: ${result.error}`);
        return result.line;
      });
    lines = { allow: parse(access.allow), deny: parse(access.deny) };
    compiled.set(access, lines);
  }
  return lines;
}

/**
 * Compares two patterns: positive when `a` is more specific, negative when `b` is, 0 when they are equally specific.
 * The specificity tuples are compared left to right, so where a segment sits in the pattern does not matter.
 */
export function compareSpecificity(a: AccessPattern, b: AccessPattern): number {
  for (let i = 0; i < a.specificity.length; i++) {
    if (a.specificity[i] !== b.specificity[i]) return a.specificity[i]! - b.specificity[i]!;
  }
  return 0;
}

/** True when `a` is at least as specific as `b` on both sides and more specific on at least one. */
function dominates(a: AccessLine, b: AccessLine): boolean {
  const from = compareSpecificity(a.from, b.from);
  const to = compareSpecificity(a.to, b.to);
  return from >= 0 && to >= 0 && (from > 0 || to > 0);
}

/**
 * Decides whether code in the bucket `from` may use code that originates in the bucket `to`. Of the lines that match
 * the edge, a line that another matching line dominates drops out. When none is left, `default` decides. When the
 * lines left come from one list, that list decides and the first of them is named. When both lists still have a
 * line, the edge is ambiguous and fails.
 */
export function evaluateAccess(access: AccessConfig, from: string, to: string): AccessDecision {
  const lines = compile(access);
  const matches = (line: AccessLine): boolean => matchesBucket(line.from, from) && matchesBucket(line.to, to);
  const matching = [...lines.allow.filter(matches).map((line) => ({ line, list: 'allow' as const })), ...lines.deny.filter(matches).map((line) => ({ line, list: 'deny' as const }))];
  const left = matching.filter((m) => !matching.some((other) => dominates(other.line, m.line)));
  const allow = left.find((m) => m.list === 'allow');
  const deny = left.find((m) => m.list === 'deny');
  if (allow !== undefined && deny !== undefined) return { allowed: false, by: 'ambiguous', allowLine: allow.line.text, denyLine: deny.line.text };
  if (allow !== undefined) return { allowed: true, by: 'allow', line: allow.line.text };
  if (deny !== undefined) return { allowed: false, by: 'deny', line: deny.line.text };
  return { allowed: access.default === 'allow', by: 'default' };
}

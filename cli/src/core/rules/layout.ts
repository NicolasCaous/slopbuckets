// Layout rule: the `layout` lines of buckets.config.json decide which bucket folders may exist. The scan asks this
// rule about every bucket folder it finds, and a folder that fails is not a bucket.
import { compareSpecificity, NO_SCRIPTS, type ScriptValues } from '../bucket-glob.js';
import type { ResolvedConfig } from '../config.js';
import { evaluateLayout, parseLayoutLine, type LayoutDecision } from '../layout-glob.js';
import { CONFIG_FILE } from '../paths.js';
import type { Violation } from '../types.js';

const OWNER = `${CONFIG_FILE} belongs to a human, so an AI agent never edits it.`;

/** Characters that a layout line reads as glob syntax, so no line can name a folder that holds one of them. */
const GLOB_CHARS = /[{}<>*`,|]/;

type Failure = Exclude<LayoutDecision, { allowed: true }>;

/**
 * layout-denied or layout-ambiguous for the bucket folder `bucketPath`, or null when it may exist or the config has
 * no `layout`. `parent` is the bucket that holds the folder, null for the root bucket. `scripts` holds the values of
 * the scripts of the config. `hasChildBuckets` is true when the folder holds folders that would be buckets, so the
 * proposed line covers them too. A function there runs only when the folder fails.
 */
export function layoutViolation(config: ResolvedConfig, bucketPath: string, parent: string | null, scripts: ScriptValues = NO_SCRIPTS, hasChildBuckets: boolean | (() => boolean) = false): Violation | null {
  const layout = config.layout;
  if (layout === undefined) return null;
  const decision = evaluateLayout(layout, bucketPath, scripts);
  if (decision.allowed) return null;
  const fix = fixText(bucketPath, parent, decision, typeof hasChildBuckets === 'function' ? hasChildBuckets() : hasChildBuckets, scripts);
  if (decision.by === 'ambiguous') {
    return {
      rule: 'layout-ambiguous',
      file: bucketPath,
      message: `Layout ambiguous: ${bucketPath}/ is a bucket folder, and the allow line "${decision.allowLine}" and the deny line "${decision.denyLine}" in "layout" of ${CONFIG_FILE} both match it. Neither is more specific than the other, so the check cannot tell which one decides. A human must add a line to "layout" that is more specific than both. ${OWNER} ${fix}`,
    };
  }
  const why =
    decision.by === 'deny'
      ? `the line "${decision.line}" in layout.deny of ${CONFIG_FILE} is the most specific line that matches it`
      : `no line in layout.allow of ${CONFIG_FILE} matches it or a bucket below it, and layout.default is "deny"`;
  return { rule: 'layout-denied', file: bucketPath, message: `Layout denied: ${bucketPath}/ is a bucket folder, but ${why}. ${OWNER} ${fix}` };
}

/** What the agent can do about the folder, and the change it may propose to the human. */
function fixText(bucketPath: string, parent: string | null, decision: Failure, hasChildBuckets: boolean, scripts: ScriptValues): string {
  const instead = parent === null ? 'The root bucket always exists, so' : `Move this folder into ${parent}/_/ if it only organizes code, remove it, or`;
  const name = bucketPath.split('/').find((segment) => GLOB_CHARS.test(segment));
  if (name !== undefined) {
    const char = GLOB_CHARS.exec(name)![0];
    return `No layout line can name this folder literally, because "${name}" holds "${char}", which a line reads as glob syntax. ${instead} rename it without the characters { } < > * \` , and |.`;
  }
  const ask = `stop and ask the human to change "layout" in ${CONFIG_FILE}`;
  const subtree = `${bucketPath}/**`;
  if (decision.by === 'deny' && (decision.line === bucketPath || decision.line === subtree)) {
    return `${instead} ${ask}: propose to remove the line "${decision.line}" from layout.deny.`;
  }
  const denyLine = decision.by === 'deny' ? decision.line : decision.by === 'ambiguous' ? decision.denyLine : undefined;
  // One line for the folder and every folder below it, unless the deny line that decided is as specific as that line.
  if (parent !== null && hasChildBuckets && (denyLine === undefined || beats(subtree, denyLine, scripts))) {
    return `${instead} ${ask}, with the exact line you propose, such as "${subtree}" in layout.allow, which allows ${bucketPath}/ and every folder below it.`;
  }
  return `${instead} ${ask}, with the exact line you propose, such as "${bucketPath}" in layout.allow.`;
}

/** True when the layout line `line` is more specific than `other`, so it decides where both match. */
function beats(line: string, other: string, scripts: ScriptValues): boolean {
  const a = parseLayoutLine(line, scripts);
  const b = parseLayoutLine(other, scripts);
  if ('error' in a || 'error' in b) return false;
  return compareSpecificity(a.line.patterns[0]!, b.line.patterns[0]!) > 0;
}

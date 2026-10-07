// Layout rule: the `layout` lines of buckets.config.json decide which bucket folders may exist. The scan asks this
// rule about every bucket folder it finds, and a folder that fails is not a bucket.
import type { ResolvedConfig } from '../config.js';
import { evaluateLayout } from '../layout-glob.js';
import { CONFIG_FILE } from '../paths.js';
import type { Violation } from '../types.js';

const OWNER = `${CONFIG_FILE} belongs to a human, so an AI agent never edits it.`;

/**
 * layout-denied or layout-ambiguous for the bucket folder `bucketPath`, or null when it may exist or the config has
 * no `layout`. `parent` is the bucket that holds the folder, null for the root bucket.
 */
export function layoutViolation(config: ResolvedConfig, bucketPath: string, parent: string | null): Violation | null {
  const layout = config.layout;
  if (layout === undefined) return null;
  const decision = evaluateLayout(layout, bucketPath);
  if (decision.allowed) return null;
  const proposal = `"${bucketPath}" in layout.allow`;
  const ask = `stop and ask the human to change "layout" in ${CONFIG_FILE}, with the exact line you propose, such as ${proposal}`;
  const fix =
    parent === null
      ? `The root bucket always exists, so ${ask}.`
      : `Move this folder into ${parent}/_/ if it only organizes code, remove it, or ${ask}.`;
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

// Access rules: the `access` lines of buckets.config.json decide which bucket may use code that originates in which
// other bucket. The edges are the ones of the bucket graph (buildEdges), so a symbol counts for its origin bucket
// whatever DMZ files it passes through.
import { evaluateAccess, parseAccessLine, type AccessConfig, type AccessDecision } from '../access-glob.js';
import { matchesBucket } from '../bucket-glob.js';
import { EXTERNAL, PARENT, SELF } from '../dmz-path.js';
import { resolveOrigin, type Model } from '../model.js';
import { CONFIG_FILE } from '../paths.js';
import type { Violation } from '../types.js';
import { buildEdges } from './cycles.js';
import type { DmzUse } from './imports.js';

const OWNER = `${CONFIG_FILE} belongs to a human, so an AI agent never edits it.`;

/** The end of every access-denied message. `what` names what the agent removes. */
function deniedAdvice(what: string): string {
  return `${OWNER} ${what}, or stop and ask the human to change "access" in ${CONFIG_FILE}.`;
}

/** The end of every access-ambiguous message. `what` names what the agent removes. */
function ambiguousAdvice(what: string): string {
  return `A human must add a line to "access" in ${CONFIG_FILE} that is more specific than both, to decide this case. ${OWNER} Stop and ask the human to add that line, or ${what.charAt(0).toLowerCase()}${what.slice(1)}.`;
}

/** The rule a failing decision reports. */
function ruleOf(decision: AccessDecision): 'access-denied' | 'access-ambiguous' {
  return decision.by === 'ambiguous' ? 'access-ambiguous' : 'access-denied';
}

/** The heading of a message about one edge. */
function heading(decision: AccessDecision, pair: string): string {
  return decision.by === 'ambiguous' ? `Access ambiguous: ${pair}.` : `Access denied: ${pair}.`;
}

/** Why the edge fails: the deciding deny line, default deny, or the two lines that leave it ambiguous. */
function failsBecause(decision: AccessDecision): string {
  if (decision.by === 'ambiguous') {
    return `The allow line "${decision.allowLine}" and the deny line "${decision.denyLine}" of ${CONFIG_FILE} both match this edge, and neither is more specific than the other on both sides, so the check cannot tell which one decides.`;
  }
  if (decision.by === 'deny') return `The line "${decision.line}" in access.deny of ${CONFIG_FILE} is the most specific line that matches this edge.`;
  return `No line in access.allow of ${CONFIG_FILE} matches this edge, and access.default is "deny".`;
}

/** The re-export chain from the DMZ file `start` to the `_/` file that declares `name`. */
function chainText(model: Model, start: string, name: string): string {
  return `The re-export chain is ${resolveOrigin(model, start, name).chain.join(' -> ')}.`;
}

/**
 * access-denied or access-ambiguous on the importing line of every edge that the access lines do not allow.
 * `reported` holds the DMZ file and symbol pairs that the early check already reported, so check --file does not
 * report them twice.
 */
function failedImports(model: Model, access: AccessConfig, uses: DmzUse[], dmzFile: string | undefined, reported: Set<string>): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const edge of buildEdges(model, uses)) {
    const decision = evaluateAccess(access, edge.from, edge.to, model.scripts);
    if (decision.allowed) continue;
    const advice = decision.by === 'ambiguous' ? ambiguousAdvice : deniedAdvice;
    const head = heading(decision, `${edge.from} -> ${edge.to}`);
    const why = `${failsBecause(decision)} ${chainText(model, edge.via, edge.symbol)}`;
    const key = JSON.stringify([edge.file, edge.line, edge.to, edge.symbol]);
    if (!seen.has(key)) {
      seen.add(key);
      violations.push({
        rule: ruleOf(decision),
        file: edge.file,
        line: edge.line,
        message: `${head} This file imports \`${edge.symbol}\` (declared in ${edge.to}) from ${edge.via}, so code in ${edge.from} uses code from ${edge.to}. ${why} ${advice(`Remove this dependency on ${edge.to} (the import of \`${edge.symbol}\` and the code that uses it)`)}`,
      });
    }
    // check --file on a DMZ file of the chain reports the edge on that file too, like the cycle rule.
    if (dmzFile === undefined || !edge.chain.includes(dmzFile)) continue;
    const dmzKey = JSON.stringify([dmzFile, edge.from, edge.to, edge.symbol]);
    if (seen.has(dmzKey) || reported.has(JSON.stringify([dmzFile, edge.symbol]))) continue;
    seen.add(dmzKey);
    const line = model.exports.get(dmzFile)?.get(edge.symbol)?.line;
    violations.push({
      rule: ruleOf(decision),
      file: dmzFile,
      ...(line !== undefined ? { line } : {}),
      message: `${head} This DMZ file re-exports \`${edge.symbol}\` (declared in ${edge.to}), and ${edge.file} imports it from ${edge.via}, so code in ${edge.from} uses code from ${edge.to}. ${why} ${advice(`Remove the import of \`${edge.symbol}\` in ${edge.file} and the code that uses it`)}`,
    });
  }
  return violations;
}

/** The buckets that may import the DMZ file, or null when they are outside the project or outside the owner. */
function candidateConsumers(model: Model, owner: string, consumer: string): string[] | null {
  if (consumer === PARENT || consumer === EXTERNAL) return null;
  if (consumer === SELF) return model.layout.buckets.has(owner) ? [owner] : [];
  const top = `${owner}/${consumer}`;
  return [...model.layout.buckets.keys()].filter((b) => b === top || b.startsWith(`${top}/`)).sort();
}

/** One sentence per reason, naming the consumers it applies to. */
function consumerReasons(decisions: Array<{ consumer: string; decision: AccessDecision }>, to: string): string[] {
  const groups = new Map<string, { decision: AccessDecision; consumers: string[] }>();
  for (const { consumer, decision } of decisions) {
    const key = JSON.stringify(decision);
    if (!groups.has(key)) groups.set(key, { decision, consumers: [] });
    groups.get(key)!.consumers.push(consumer);
  }
  return [...groups.values()].map(({ decision, consumers }) => {
    const edges = consumers.map((c) => `${c} -> ${to}`).join(', ');
    if (decision.by === 'ambiguous') {
      return `For ${edges}, the allow line "${decision.allowLine}" and the deny line "${decision.denyLine}" both match, and neither is more specific than the other on both sides.`;
    }
    if (decision.by === 'deny') return `The line "${decision.line}" in access.deny of ${CONFIG_FILE} is the most specific line that matches ${edges}.`;
    return `No line in access.allow of ${CONFIG_FILE} matches ${edges}, and access.default is "deny".`;
  });
}

/**
 * The early check on DMZ files, on the export line of a symbol that no candidate consumer of the file may use. The
 * consumers of `P/dmz/<provider>/<child>` are the buckets of `P/<child>`, the consumer of `P/dmz/<provider>/.self` is
 * `P`. A `.parent` or `.external` file has consumers outside `P`, so it is skipped. When the lines leave the edge of
 * some consumer ambiguous, the rule is access-ambiguous, because a human can still decide those edges either way.
 */
function failedReexports(model: Model, access: AccessConfig, reported: Set<string>): Violation[] {
  const violations: Violation[] = [];
  for (const [file, dmz] of model.layout.dmzFiles) {
    const consumers = candidateConsumers(model, dmz.owner, dmz.consumer);
    if (consumers === null || consumers.length === 0) continue;
    for (const [name, entry] of model.exports.get(file) ?? []) {
      const origin = resolveOrigin(model, file, name);
      if (origin.bucket === null) continue;
      const to = origin.bucket;
      // A consumer that is the origin itself uses its own code, which is never an edge.
      if (consumers.includes(to)) continue;
      const decisions = consumers.map((consumer) => ({ consumer, decision: evaluateAccess(access, consumer, to, model.scripts) }));
      if (decisions.some((d) => d.decision.allowed)) continue;
      const ambiguous = decisions.some((d) => d.decision.by === 'ambiguous');
      const who =
        consumers.length === 1
          ? `its consumer ${consumers[0]} ${ambiguous ? 'has no clear permission to use' : 'may not use'}`
          : `none of the buckets that may import it (${consumers.join(', ')}) ${ambiguous ? 'has a clear permission to use' : 'may use'}`;
      const remove = `Remove \`${name}\` from this file`;
      reported.add(JSON.stringify([file, name]));
      violations.push({
        rule: ambiguous ? 'access-ambiguous' : 'access-denied',
        file,
        line: entry.line,
        message: `${ambiguous ? 'Access ambiguous' : 'Access denied'} for every consumer of this DMZ file: it re-exports \`${name}\` (declared in ${to}), but ${who} code from ${to}. ${consumerReasons(decisions, to).join(' ')} ${chainText(model, file, name)} ${ambiguous ? ambiguousAdvice(remove) : deniedAdvice(remove)}`,
      });
    }
  }
  return violations;
}

/**
 * access-unknown-bucket for each side without wildcards that names no bucket of the project, on the line of the access
 * line in buckets.config.json when `lines` knows it.
 */
function unknownBuckets(model: Model, access: AccessConfig, lines: ReadonlyMap<string, number>): Violation[] {
  const violations: Violation[] = [];
  const buckets = [...model.layout.buckets.keys()];
  const root = model.config.root;
  for (const list of ['allow', 'deny'] as const) {
    for (const text of access[list]) {
      const parsed = parseAccessLine(text);
      if ('error' in parsed) continue; // validateConfig already rejects it.
      for (const [side, pattern] of [['left', parsed.line.from], ['right', parsed.line.to]] as const) {
        if (!pattern.literal || buckets.some((b) => matchesBucket(pattern, b))) continue;
        const line = lines.get(`${list} ${parsed.line.text}`);
        violations.push({
          rule: 'access-unknown-bucket',
          file: CONFIG_FILE,
          ...(line !== undefined ? { line } : {}),
          message: `The line "${parsed.line.text}" in access.${list} names the bucket ${pattern.text} on its ${side} side, but no bucket has that path, so the line matches nothing. A bucket path starts with the root folder "${root}", such as ${root}/billing. This happens when a bucket folder is renamed, moved or deleted, or when the path has a typo. ${OWNER} If you renamed or moved that bucket, move it back, or stop and ask the human to fix the line.`,
        });
      }
    }
  }
  return violations;
}

/**
 * The access rules, or nothing when the config has no `access` key. With `dmzFile` (check --file on a DMZ file),
 * each failing edge whose symbol passes through that file is also reported on it. `configLines` gives the line of
 * each access line in buckets.config.json, as `accessLineNumbers` reads it.
 */
export function checkAccess(model: Model, uses: DmzUse[], dmzFile?: string, configLines: ReadonlyMap<string, number> = new Map()): Violation[] {
  const access = model.config.access;
  if (access === undefined) return [];
  const reported = new Set<string>();
  const early = failedReexports(model, access, reported);
  return [...failedImports(model, access, uses, dmzFile, reported), ...early, ...unknownBuckets(model, access, configLines)];
}

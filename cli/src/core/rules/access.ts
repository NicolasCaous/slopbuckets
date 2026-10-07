// Access rules: the `access` lines of buckets.config.json decide which bucket may use code that originates in which
// other bucket. The edges are the ones of the bucket graph (buildEdges), so a symbol counts for its origin bucket
// whatever DMZ files it passes through.
import { evaluateAccess, matchesBucket, parseAccessLine, type AccessConfig, type AccessDecision } from '../access-glob.js';
import { EXTERNAL, PARENT, SELF } from '../dmz-path.js';
import { resolveOrigin, type Model } from '../model.js';
import { CONFIG_FILE } from '../paths.js';
import type { Violation } from '../types.js';
import { buildEdges } from './cycles.js';
import type { DmzUse } from './imports.js';

/** The rest of every access-denied message: who owns the config, and the two ways out. `what` names what to remove. */
function ownerAdvice(what: string): string {
  return `${CONFIG_FILE} belongs to a human, so an AI agent never edits it. ${what}, or stop and ask the human to change "access" in ${CONFIG_FILE}.`;
}

/** Why the decision denies the edge: the deny line that matched, or default deny with no matching allow line. */
function deniedBecause(decision: AccessDecision): string {
  if (decision.by === 'deny') return `The line "${decision.line}" in access.deny of ${CONFIG_FILE} matches this edge.`;
  return `No line in access.allow of ${CONFIG_FILE} matches this edge, and access.default is "deny".`;
}

/** The re-export chain from the DMZ file `start` to the `_/` file that declares `name`. */
function chainText(model: Model, start: string, name: string): string {
  return `The re-export chain is ${resolveOrigin(model, start, name).chain.join(' -> ')}.`;
}

/**
 * access-denied on the importing line of every edge that the access lines deny. `reported` holds the DMZ file and
 * symbol pairs that the early check already reported, so check --file does not report them twice.
 */
function deniedImports(model: Model, access: AccessConfig, uses: DmzUse[], dmzFile: string | undefined, reported: Set<string>): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const edge of buildEdges(model, uses)) {
    const decision = evaluateAccess(access, edge.from, edge.to);
    if (decision.allowed) continue;
    const pair = `${edge.from} -> ${edge.to}`;
    const reason = deniedBecause(decision);
    const chain = chainText(model, edge.via, edge.symbol);
    const key = JSON.stringify([edge.file, edge.line, edge.to, edge.symbol]);
    if (!seen.has(key)) {
      seen.add(key);
      violations.push({
        rule: 'access-denied',
        file: edge.file,
        line: edge.line,
        message: `Access denied: ${pair}. This file imports \`${edge.symbol}\` (declared in ${edge.to}) from ${edge.via}, so code in ${edge.from} uses code from ${edge.to}. ${reason} ${chain} ${ownerAdvice(`Remove this dependency on ${edge.to} (the import of \`${edge.symbol}\` and the code that uses it)`)}`,
      });
    }
    // check --file on a DMZ file of the chain reports the edge on that file too, like the cycle rule.
    if (dmzFile === undefined || !edge.chain.includes(dmzFile)) continue;
    const dmzKey = JSON.stringify([dmzFile, edge.from, edge.to, edge.symbol]);
    if (seen.has(dmzKey) || reported.has(JSON.stringify([dmzFile, edge.symbol]))) continue;
    seen.add(dmzKey);
    const line = model.exports.get(dmzFile)?.get(edge.symbol)?.line;
    violations.push({
      rule: 'access-denied',
      file: dmzFile,
      ...(line !== undefined ? { line } : {}),
      message: `Access denied: ${pair}. This DMZ file re-exports \`${edge.symbol}\` (declared in ${edge.to}), and ${edge.file} imports it from ${edge.via}, so code in ${edge.from} uses code from ${edge.to}. ${reason} ${chain} ${ownerAdvice(`Remove the import of \`${edge.symbol}\` in ${edge.file} and the code that uses it`)}`,
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

/**
 * The early check on DMZ files: access-denied on the export line of a symbol that no candidate consumer of the file
 * may use. The consumers of `P/dmz/<provider>/<child>` are the buckets of `P/<child>`, the consumer of
 * `P/dmz/<provider>/.self` is `P`. A `.parent` or `.external` file has consumers outside `P`, so it is skipped.
 */
function deniedReexports(model: Model, access: AccessConfig, reported: Set<string>): Violation[] {
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
      const decisions = consumers.map((c) => ({ consumer: c, decision: evaluateAccess(access, c, to) }));
      if (decisions.some((d) => d.decision.allowed)) continue;
      const byLine = new Map<string, string[]>();
      for (const { consumer, decision } of decisions) {
        const reason = decision.by === 'deny' ? `deny:${decision.line}` : 'default';
        if (!byLine.has(reason)) byLine.set(reason, []);
        byLine.get(reason)!.push(consumer);
      }
      const reasons = [...byLine].map(([reason, list]) =>
        reason === 'default'
          ? `No line in access.allow of ${CONFIG_FILE} matches ${list.map((c) => `${c} -> ${to}`).join(', ')}, and access.default is "deny".`
          : `The line "${reason.slice('deny:'.length)}" in access.deny of ${CONFIG_FILE} denies ${list.map((c) => `${c} -> ${to}`).join(', ')}.`,
      );
      const who =
        consumers.length === 1
          ? `its consumer ${consumers[0]} may not use`
          : `none of the buckets that may import it (${consumers.join(', ')}) may use`;
      reported.add(JSON.stringify([file, name]));
      violations.push({
        rule: 'access-denied',
        file,
        line: entry.line,
        message: `Access denied for every consumer of this DMZ file: it re-exports \`${name}\` (declared in ${to}), but ${who} code from ${to}. ${reasons.join(' ')} ${chainText(model, file, name)} ${ownerAdvice(`Remove \`${name}\` from this file`)}`,
      });
    }
  }
  return violations;
}

/** access-unknown-bucket for each side without wildcards that names no bucket of the project. */
function unknownBuckets(model: Model, access: AccessConfig): Violation[] {
  const violations: Violation[] = [];
  const buckets = [...model.layout.buckets.keys()];
  const root = model.config.root;
  for (const list of ['allow', 'deny'] as const) {
    for (const text of access[list]) {
      const parsed = parseAccessLine(text);
      if ('error' in parsed) continue; // validateConfig already rejects it.
      for (const [side, pattern] of [['left', parsed.line.from], ['right', parsed.line.to]] as const) {
        if (!pattern.literal || buckets.some((b) => matchesBucket(pattern, b))) continue;
        violations.push({
          rule: 'access-unknown-bucket',
          file: CONFIG_FILE,
          message: `The line "${parsed.line.text}" in access.${list} names the bucket ${pattern.text} on its ${side} side, but no bucket has that path, so the line matches nothing. A bucket path starts with the root folder "${root}", such as ${root}/billing. This happens when a bucket folder is renamed, moved or deleted, or when the path has a typo. ${CONFIG_FILE} belongs to a human, so an AI agent never edits it. If you renamed or moved that bucket, move it back, or stop and ask the human to fix the line.`,
        });
      }
    }
  }
  return violations;
}

/**
 * The access rules, or nothing when the config has no `access` key. With `dmzFile` (check --file on a DMZ file),
 * each denied edge whose symbol passes through that file is also reported on it.
 */
export function checkAccess(model: Model, uses: DmzUse[], dmzFile?: string): Violation[] {
  const access = model.config.access;
  if (access === undefined) return [];
  const reported = new Set<string>();
  const early = deniedReexports(model, access, reported);
  return [...deniedImports(model, access, uses, dmzFile, reported), ...early, ...unknownBuckets(model, access)];
}

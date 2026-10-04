// Orphan contracts: every DMZ symbol must reach an import in some `_/`, directly or through other DMZ re-exports.
// The marking starts at the imports and walks the re-export chains in one pass, so a whole unused chain shows up at once.
import { EXTERNAL } from '../dmz-path.js';
import { resolveOrigin, type Model } from '../model.js';
import type { Violation } from '../types.js';
import type { DmzUse } from './imports.js';

export interface OrphanChain {
  /** The project of the chain in a recursive report, like `Violation.project`. */
  project?: string;
  symbol: string;
  origin: string | null;
  /** DMZ files from the origin side to the tip. */
  files: string[];
}

const key = (file: string, name: string): string => `${file}\0${name}`;

/**
 * `syntaxBroken` lists the DMZ files with a dmz-syntax violation. One of them can look empty only because the adapter
 * drops a re-export that breaks the syntax, such as a rename with `as`, so its message points at that violation.
 */
export function checkOrphans(
  model: Model,
  uses: DmzUse[],
  syntaxBroken: ReadonlySet<string> = new Set(),
): { violations: Violation[]; chains: OrphanChain[] } {
  const used = new Set<string>();
  const mark = (file: string, name: string): void => {
    let current = file;
    while (!used.has(key(current, name))) {
      const entry = model.exports.get(current)?.get(name);
      if (!entry) return;
      used.add(key(current, name));
      if (!model.exports.has(entry.from)) return;
      current = entry.from;
    }
  };
  for (const use of uses) for (const name of use.usedNames) mark(use.target, name);
  // A `.external` file is consumed outside the project, so its symbols count as used, and so does the chain behind them.
  const isExternal = (file: string): boolean => model.layout.dmzFiles.get(file)?.consumer === EXTERNAL;
  for (const [file, byName] of model.exports) if (isExternal(file)) for (const name of byName.keys()) mark(file, name);

  // Re-exporters of each (file, name), to find the tips of unused chains.
  const reexporters = new Map<string, string[]>();
  for (const [file, byName] of model.exports) {
    for (const entry of byName.values()) {
      const k = key(entry.from, entry.name);
      if (!reexporters.has(k)) reexporters.set(k, []);
      reexporters.get(k)!.push(file);
    }
  }

  const unused = (file: string, name: string): boolean => model.exports.get(file)?.has(name) === true && !used.has(key(file, name));

  const chains: OrphanChain[] = [];
  for (const [file, byName] of model.exports) {
    for (const name of byName.keys()) {
      if (!unused(file, name)) continue;
      const isTip = !(reexporters.get(key(file, name)) ?? []).some((r) => unused(r, name));
      if (!isTip) continue;
      const files = [file];
      const seen = new Set(files);
      let current = file;
      for (;;) {
        const from = model.exports.get(current)!.get(name)!.from;
        if (seen.has(from) || !unused(from, name)) break;
        files.unshift(from);
        seen.add(from);
        current = from;
      }
      chains.push({ symbol: name, origin: resolveOrigin(model, file, name).bucket, files });
    }
  }
  chains.sort((a, b) => (a.files.join('\n') + a.symbol < b.files.join('\n') + b.symbol ? -1 : 1));

  const violations: Violation[] = [];
  for (const [file, byName] of model.exports) {
    if (isExternal(file)) continue;
    if (byName.size === 0) {
      violations.push({
        rule: 'dmz-orphan',
        file,
        message: syntaxBroken.has(file)
          ? `${file} re-exports nothing that the DMZ rules accept, so it counts as an empty, orphan contract. Fix its dmz-syntax violations first, and remove the file only if nothing should consume it.`
          : `${file} re-exports nothing. An empty DMZ file is an orphan contract. Delete the file.`,
      });
      continue;
    }
    for (const [name, entry] of byName) {
      if (!unused(file, name)) continue;
      const chain = chains.find((c) => c.symbol === name && c.files.includes(file));
      const files = chain?.files ?? [file];
      const tip = files[files.length - 1]!;
      const origin = chain?.origin ?? null;
      const chainText = `Unused chain from origin to tip: ${files.join(' -> ')}. Delete \`${name}\` from every file in that chain (delete a file once it is empty)`;
      // Files that import the name from the chain but never use it: an unused import, or a re-export nobody in the bucket uses.
      const importers = [...new Set(uses.filter((u) => files.includes(u.target) && u.names.includes(name)).map((u) => u.file))].sort();
      violations.push({
        rule: 'dmz-orphan',
        file,
        line: entry.line,
        message:
          importers.length === 0
            ? `Orphan contract: \`${name}\` (origin: ${origin ?? 'unknown'}) is re-exported here, but no _/ code imports it, directly or through another DMZ. ${chainText}, or import it by name from ${tip} in the consumer's _/ code.`
            : `Orphan contract: \`${name}\` (origin: ${origin ?? 'unknown'}) is re-exported here, and ${importers.join(', ')} ${importers.length === 1 ? 'imports' : 'import'} it but never ${importers.length === 1 ? 'uses' : 'use'} it. An import that the file never references does not count, and neither does a re-export that no other file of the same bucket imports and uses. ${chainText}, or reference \`${name}\` in the code of ${importers.join(', ')}, or in a file of the same bucket that imports it from there.`,
      });
    }
  }
  return { violations, chains };
}

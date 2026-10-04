// Barrels inside `_/`: a file that re-exports a DMZ symbol to the rest of its bucket.
//
// `export { a } from '<dmz>'` (or `import { a }` plus `export { a }`) passes the symbol on without using it,
// so on its own it does not keep the contract alive. It counts once another file of the same bucket imports
// the name from the barrel and really uses it. Barrels can re-export from other barrels, so the uses are
// followed backwards from each real use until they reach the DMZ import, in one pass over a worklist.
import type { DmzUse } from './imports.js';

/** One allowed import of a code file whose target is in the same bucket: a `_/` file of the bucket or a DMZ file. */
export interface BucketImport {
  /** The importing file. */
  file: string;
  /** The imported file. */
  target: string;
  /** Names the file uses itself: imported names it references, `*` for a namespace import it references. */
  usedNames: string[];
  /** Imported names the file exports again, with the exported name. See `ImportEntry.reexportedAs`. */
  reexportedAs: { name: string; as: string }[];
  /** Set when the target is a DMZ file: the use that gains the names the bucket really uses. */
  dmzUse?: DmzUse;
}

/**
 * Adds to each `dmzUse.usedNames` the names that reach a real use through barrels of the same bucket.
 * A name nobody in the bucket uses stays unused, so the orphan rule still reports the contract.
 */
export function addBarrelUses(imports: BucketImport[]): void {
  const byImporter = new Map<string, BucketImport[]>();
  for (const imp of imports) {
    if (imp.reexportedAs.length === 0) continue;
    const list = byImporter.get(imp.file) ?? [];
    list.push(imp);
    byImporter.set(imp.file, list);
  }
  if (byImporter.size === 0) return;

  // (file, name) pairs known to be used: `name` is exported by `file`, `*` means its whole namespace.
  const seen = new Set<string>();
  const work: [string, string][] = [];
  const mark = (file: string, name: string): void => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    work.push([file, name]);
  };
  for (const imp of imports) {
    if (imp.dmzUse === undefined) for (const name of imp.usedNames) mark(imp.target, name);
  }

  while (work.length > 0) {
    const [file, name] = work.pop()!;
    for (const imp of byImporter.get(file) ?? []) {
      for (const pair of imp.reexportedAs) {
        const spread = pair.name === '*' && pair.as === '*';
        if (!(name === '*' || pair.as === name || (spread && name !== 'default'))) continue;
        // The name the barrel takes from its target: the same name through `export *`, else the imported name.
        const taken = spread ? name : pair.name;
        if (imp.dmzUse === undefined) mark(imp.target, taken);
        else if (taken !== '*' && imp.dmzUse.names.includes(taken) && !imp.dmzUse.usedNames.includes(taken)) imp.dmzUse.usedNames.push(taken);
      }
    }
  }
}

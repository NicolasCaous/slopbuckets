// Where each DMZ re-export may point (the "Para onde cada reexportação pode apontar" table).
import { PARENT, SELF, type DmzFile } from '../dmz-path.js';
import { isPublishedLinkFile, linkOf, nestedProjectOf, type Model } from '../model.js';
import { parentPath, splitBucketPath } from '../paths.js';
import type { Violation } from '../types.js';

/** True when `target` is in the surface of bucket `bucket`: `bucket/_/**` or `bucket/dmz/<x>/.parent<ext>`. */
export function inSurface(model: Model, bucket: string, target: string): boolean {
  const split = splitBucketPath(model.config.root, target);
  if (!split || split.bucket !== bucket) return false;
  if (split.area === '_') return split.rest !== '';
  if (split.area === 'dmz') {
    const parts = split.rest.split('/');
    return parts.length === 2 && parts[1] === `${PARENT}${model.dmzExtension}`;
  }
  return false;
}

/** Describes what a DMZ file may re-export from, and checks one target against it. */
export function targetRule(model: Model, dmz: DmzFile): { allows(target: string): boolean; describe: string } {
  const ext = model.dmzExtension;
  if (dmz.provider === SELF) {
    const prefix = `${dmz.owner}/_/`;
    return {
      allows: (t) => t.startsWith(prefix) && t.length > prefix.length,
      describe: `${dmz.owner}/_/** (the code of ${dmz.owner})`,
    };
  }
  if (dmz.provider === PARENT) {
    const grandParent = parentPath(dmz.owner);
    const ownerName = dmz.owner.slice(grandParent.length + 1);
    return {
      allows: (t) => {
        const split = splitBucketPath(model.config.root, t);
        if (!split || split.bucket !== grandParent || split.area !== 'dmz') return false;
        const parts = split.rest.split('/');
        return parts.length === 2 && parts[1] === `${ownerName}${ext}`;
      },
      describe: `${grandParent}/dmz/<provider>/${ownerName}${ext} (contracts where ${dmz.owner} is the consumer)`,
    };
  }
  const child = `${dmz.owner}/${dmz.provider}`;
  return {
    allows: (t) => inSurface(model, child, t),
    describe: `the surface of ${child}: ${child}/_/** or ${child}/dmz/<child>/${PARENT}${ext}`,
  };
}

export function checkDmzTargets(model: Model): Violation[] {
  const violations: Violation[] = [];
  for (const dmz of model.layout.dmzFiles.values()) {
    const rule = targetRule(model, dmz);
    for (const entry of model.response.dmz[dmz.file]?.exports ?? []) {
      const nested = nestedProjectOf(model, entry.from);
      if (nested !== null) {
        violations.push({
          rule: 'dmz-target',
          file: dmz.file,
          line: entry.line,
          message: `\`${entry.name}\` is re-exported from ${entry.from}, inside the nested project ${nested}/. A nested project is opaque to this project, so no contract can point into it. Publish the symbol in ${nested} with a .external${model.dmzExtension} file, consume it with \`buckets link add\`, or remove the re-export.`,
        });
        continue;
      }
      // A contract is code of this project too: it reaches a linked project only through its published files.
      const link = linkOf(model, entry.from);
      if (link !== null && !isPublishedLinkFile(model, link, entry.from)) {
        violations.push({
          rule: 'link-forbidden-import',
          file: dmz.file,
          line: entry.line,
          message: `\`${entry.name}\` is re-exported from ${entry.from}, which is inside the linked project in ${link} but is not one of its published .external${model.dmzExtension} files. A contract may re-export a linked project only from those files. If the symbol is not published, it must be added to a .external${model.dmzExtension} file in the origin project, which that project's human approves.`,
        });
        continue;
      }
      if (rule.allows(entry.from)) continue;
      violations.push({
        rule: 'dmz-target',
        file: dmz.file,
        line: entry.line,
        message: `\`${entry.name}\` is re-exported from ${entry.from}, but ${dmz.file} may only re-export from ${rule.describe}. Point the re-export at an allowed file, adding the intermediate DMZ re-exports if needed, or remove it.`,
      });
    }
  }
  return violations;
}

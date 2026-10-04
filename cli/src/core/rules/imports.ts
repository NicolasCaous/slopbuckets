// Import rules for code inside `X/_/`.
import path from 'node:path';
import { PARENT, SELF } from '../dmz-path.js';
import { isDmzLocation, isPublishedLinkFile, linkOf, linkOfAlias, nestedProjectOf, removedLinkOfAlias, toSpecifier, type Model } from '../model.js';
import { codeBucket, parentPath, splitBucketPath } from '../paths.js';
import type { Violation } from '../types.js';
import { addBarrelUses, type BucketImport } from './barrels.js';

/** An allowed import of named symbols from a DMZ file. Cycles and orphans are built from these. */
export interface DmzUse {
  file: string;
  bucket: string;
  line: number;
  target: string;
  /** Every name the statement imports. Each one is a dependency, so the bucket graph uses all of them. */
  names: string[];
  /**
   * The names that count as a use of the contract for the orphan rule: the names the file references.
   * A re-export (`export { x } from` in code) passes the symbol on without using it, so it counts only
   * when another file of the same bucket imports the name from it and uses it (see barrels.ts).
   */
  usedNames: string[];
}

/** Ends a message from the adapter with a period so more text can follow. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** `root/a/_/x.ts (@root/a/_/x)`, or just the path for a file outside the root folder. */
function describeTarget(model: Model, target: string): string {
  const specifier = toSpecifier(model, target);
  return specifier === target ? target : `${target} (${specifier})`;
}

function lastSegment(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** How code imports a published file of a link: the origin alias and the path inside the link, without extension. */
function linkSpecifier(model: Model, link: string, file: string): string {
  const alias = model.linkInfo.get(link)?.alias ?? '<origin alias>';
  const rest = file.slice(link.length + 1).replace(/\.[^./]+$/, '');
  return `${alias}/${rest}`;
}

/**
 * Why an import of a link alias did not resolve, or null when the link is missing on disk (link-missing already says
 * to run `buckets link sync`). `spec` is the import specifier.
 */
function unresolvedLinkMessage(model: Model, spec: string): string | null {
  const link = linkOfAlias(model, spec);
  if (link === null) return null;
  const info = model.linkInfo.get(link)!;
  if (!info.present) return '';
  return `Import "${spec}" uses the alias ${info.alias} of the project linked in ${link}, but it does not resolve to a file. Import only the published .external files of that project, such as ${info.alias}/dmz/<bucket>/.external, and check that tsconfig.json maps "${info.alias}/*" to ["./${link}/*"] in compilerOptions.paths (\`buckets link add\` writes that line).`;
}

/**
 * The message for an import through the alias of a link that `buckets link remove` removed, or null. `spec` is the
 * specifier, or the package name the adapter made of it.
 */
function removedLinkMessage(model: Model, spec: string): string | null {
  const removed = removedLinkOfAlias(model, spec);
  if (removed === null) return null;
  const name = lastSegment(removed.link);
  return `This import goes through ${removed.alias}, the alias of the project that was linked in ${removed.link}. That link was removed with \`buckets link remove ${name}\`: buckets.links.json no longer lists it, and only the approved buckets.lock.json still does. Remove the imports of ${removed.alias}, or replace them with code of this project. To use that project again, link it once more with \`buckets link add\`.`;
}

/** The project path that a relative specifier written in `file` points at, with `/`. It starts with `..` when it leaves the project. */
function relativeTarget(file: string, spec: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
}
/** True when code in bucket `bucket` may import the project file `target`. */
export function importAllowed(model: Model, bucket: string, target: string): boolean {
  if (target.startsWith(`${bucket}/_/`)) return true;
  const split = splitBucketPath(model.config.root, target);
  if (!split || split.area !== 'dmz') return false;
  const parts = split.rest.split('/');
  if (parts.length !== 2) return false;
  const consumerFile = parts[1]!;
  const ext = model.dmzExtension;
  const parent = model.layout.buckets.get(bucket)?.parent ?? null;
  if (parent !== null && split.bucket === parent && consumerFile === `${lastSegment(bucket)}${ext}`) return true;
  if (split.bucket === bucket && parts[0] !== SELF && parts[0] !== PARENT && consumerFile === `${SELF}${ext}`) return true;
  return false;
}

function allowedSummary(model: Model, bucket: string): string {
  const alias = model.config.alias;
  const rel = (p: string): string => (p === model.config.root ? '' : p.slice(model.config.root.length + 1) + '/');
  const items = [`${alias}/${rel(bucket)}_/** (its own code)`];
  const parent = model.layout.buckets.get(bucket)?.parent ?? null;
  if (parent !== null) items.push(`${alias}/${rel(parent)}dmz/<provider>/${lastSegment(bucket)} (contracts ${lastSegment(bucket)} consumes)`);
  items.push(`${alias}/${rel(bucket)}dmz/<child>/${SELF} (contracts its children offer it)`);
  items.push('packages declared in package.json', 'Node built-in modules');
  return items.join('; ');
}

/** Suggests the DMZ file through which `bucket` should consume code from `provider`. */
function suggestContract(model: Model, bucket: string, provider: string): string {
  const ext = model.dmzExtension;
  const parent = model.layout.buckets.get(bucket)?.parent ?? null;
  if (parent !== null && parentPath(provider) === parent && provider !== bucket) {
    return `Re-export it in ${parent}/dmz/${lastSegment(provider)}/${lastSegment(bucket)}${ext} and import from there.`;
  }
  if (parentPath(provider) === bucket) {
    return `Re-export it in ${bucket}/dmz/${lastSegment(provider)}/${SELF}${ext} and import from there.`;
  }
  if (parent !== null && provider === parent) {
    return `Re-export it in ${parent}/dmz/${SELF}/${lastSegment(bucket)}${ext} and import from there.`;
  }
  if (parent !== null) {
    return `Expose it through the DMZs of the common ancestor and pass it down with ${parent}/dmz/${PARENT}/${lastSegment(bucket)}${ext}, then import from that file.`;
  }
  return 'Expose it upward with <child>/dmz/<grandchild>/.parent files and re-export it to the root code in ' + `${bucket}/dmz/<child>/${SELF}${ext}.`;
}

export function checkImports(model: Model): { violations: Violation[]; uses: DmzUse[] } {
  const violations: Violation[] = [];
  const uses: DmzUse[] = [];
  const bucketImports: BucketImport[] = [];
  const root = model.config.root;

  for (const file of model.layout.codeFiles) {
    const bucket = codeBucket(root, file);
    if (bucket === null) continue;
    const analyzed = Object.hasOwn(model.response.code, file) ? model.response.code[file] : undefined;
    for (const global of analyzed?.globals ?? []) {
      violations.push({
        rule: 'import-global',
        file,
        line: global.line,
        // The adapter's message ends with the fix for this kind of global, so no generic advice follows it.
        message: `${sentence(global.message)} Code in _/ may share code only through import statements, because the check follows imports to find which bucket uses which.`,
      });
    }
    for (const imp of analyzed?.imports ?? []) {
      const at = { file, line: imp.line };
      switch (imp.kind) {
        case 'builtin':
          break;
        case 'relative': {
          const where = relativeTarget(file, imp.target ?? '.');
          const outside = where === '..' || where.startsWith('../');
          violations.push({
            rule: 'import-relative',
            ...at,
            message: outside
              ? `Relative import "${imp.target}" leaves this project (it points at ${where}, outside the project folder). slopbuckets forbids relative imports, and code outside this project is reached only through \`buckets link\`: if that code is a slopbuckets project, run \`buckets link add <name> <its project folder>\` in ${bucket}, then import its published .external files through its alias. Otherwise publish it as a package and declare it in package.json.`
              : `Relative import "${imp.target}". slopbuckets forbids relative imports everywhere, even inside the same _/ folder. Rewrite it with the alias, as ${model.config.alias}/<path from ${root}>.`,
          });
          break;
        }
        case 'dynamic':
          violations.push({
            rule: 'import-dynamic',
            ...at,
            message: `Dynamic import or require(${imp.target === null ? 'non-literal' : `"${imp.target}"`}). The check cannot follow dynamic imports, so they are forbidden. Replace it with a static import declaration at the top of the file.`,
          });
          break;
        case 'unresolved': {
          // An import of a registered link that is missing on disk: link-missing already says to run `buckets link sync`.
          const spec = imp.target ?? '';
          const removedMessage = removedLinkMessage(model, spec);
          if (removedMessage !== null) {
            violations.push({ rule: 'import-unresolved', ...at, message: `Import "${spec}" does not resolve. ${removedMessage}` });
            break;
          }
          const linkMessage = unresolvedLinkMessage(model, spec);
          if (linkMessage === '') break;
          if (linkMessage !== null) {
            violations.push({ rule: 'import-unresolved', ...at, message: linkMessage });
            break;
          }
          violations.push({
            rule: 'import-unresolved',
            ...at,
            message: `Import "${imp.target}" could not be resolved to a file, package or built-in module. Fix the path (internal imports use ${model.config.alias}/... and must point at an existing file) or add the package to package.json.`,
          });
          break;
        }
        case 'package': {
          // Without the tsconfig paths entry, an import of a link alias such as `@api-k3x9pm2a/dmz/x/.external` looks like a scoped package.
          // After `buckets link remove`, the tsconfig paths entry is gone, so the alias reads as an undeclared package.
          const removedMessage = imp.declared === false ? removedLinkMessage(model, imp.target ?? '') : null;
          if (removedMessage !== null) {
            violations.push({ rule: 'import-unresolved', ...at, message: `Import of ${imp.target}/... does not resolve. ${removedMessage}` });
            break;
          }
          const linkMessage = imp.declared === false ? unresolvedLinkMessage(model, imp.target ?? '') : null;
          if (linkMessage === '') break;
          if (linkMessage !== null) {
            violations.push({ rule: 'import-unresolved', ...at, message: linkMessage });
            break;
          }
          if (imp.declared === false) {
            violations.push({
              rule: 'import-undeclared-package',
              ...at,
              message: `Package "${imp.target}" is not declared in package.json. Add it to dependencies or devDependencies, or stop importing it.`,
            });
          }
          break;
        }
        case 'internal': {
          const target = imp.target ?? '';
          const names = imp.names ?? [];
          const nested = nestedProjectOf(model, target);
          if (nested !== null) {
            violations.push({
              rule: 'import-forbidden',
              ...at,
              message: `Import of ${target} reaches into ${nested}/, which is a separate slopbuckets project nested in ${bucket}. Projects never import each other's files. Publish what this code needs in that project with a <parent>/dmz/<bucket>/.external${model.dmzExtension} file, link that project here with \`buckets link add <name> <path to the folder ${nested}>\`, run in the bucket that uses it, and import through the alias of that project, such as <its alias>/dmz/<bucket>/.external.`,
            });
            break;
          }
          const link = linkOf(model, target);
          if (link !== null && !isPublishedLinkFile(model, link, target)) {
            const published = (model.response.links?.[link]?.exports ?? []).map((e) => e.file);
            const examples = [...new Set(published)].sort().slice(0, 3).map((f) => `'${linkSpecifier(model, link, f)}'`);
            violations.push({
              rule: 'link-forbidden-import',
              ...at,
              message: `Import of ${target} reaches inside the linked project in ${link}. Code may import a linked project only through its published .external${model.dmzExtension} files${examples.length > 0 ? `, such as ${examples.join(', ')}` : `, imported as ${linkSpecifier(model, link, `${link}/dmz/<bucket>/.external${model.dmzExtension}`)}`}. If the symbol you need is not published, it must be added to a .external${model.dmzExtension} file in the origin project, which that project's human approves.`,
            });
            break;
          }
          const isDmz = isDmzLocation(model, target);
          const allowed = importAllowed(model, bucket, target);
          if (!allowed) {
            const provider = splitBucketPath(root, target)?.bucket ?? null;
            const hint =
              provider === null
                ? ` ${target} is outside ${root}/, and bucket code may not import project files outside ${root}/. Move that code into the bucket that owns it, or publish it as a package and declare it in package.json.`
                : provider !== bucket && !isDmz
                  ? ` ${suggestContract(model, bucket, provider)}`
                  : '';
            violations.push({
              rule: 'import-forbidden',
              ...at,
              message: `Import of ${describeTarget(model, target)} is outside what bucket ${bucket} may import. Code in ${bucket}/_/ may import only: ${allowedSummary(model, bucket)}.${hint} A new or changed contract needs a human to approve it: ask with \`buckets refresh --web\`, or a human runs \`buckets refresh\`.`,
            });
          }
          if (isDmz && names.includes('*')) {
            violations.push({
              rule: 'import-namespace-dmz',
              ...at,
              message: `Namespace import (import * as) of the DMZ file ${target}. The check must see which contract symbols are used, so import each symbol by name: import { a, b } from '${toSpecifier(model, target)}'.`,
            });
          }
          if (allowed && isDmz) {
            const named = names.filter((n) => n !== '*');
            // A re-export or a name the file never references would keep an unused contract alive without a real consumer.
            // "*" in unusedNames marks an unused namespace import, which never counts as a use of a DMZ file anyway.
            const unused = new Set(imp.unusedNames ?? []);
            const usedNames = imp.reexport === true ? [] : named.filter((n) => !unused.has(n));
            if (named.length > 0) {
              const use: DmzUse = { file, bucket, line: imp.line, target, names: named, usedNames };
              uses.push(use);
              if (imp.reexportedAs !== undefined) bucketImports.push({ file, target, usedNames: [], reexportedAs: imp.reexportedAs, dmzUse: use });
            }
          } else if (allowed) {
            // Own code: followed only to find barrels that pass a DMZ symbol on.
            const unused = new Set(imp.unusedNames ?? []);
            const usedNames = imp.reexport === true ? [] : names.filter((n) => !unused.has(n));
            bucketImports.push({ file, target, usedNames, reexportedAs: imp.reexportedAs ?? [] });
          }
          break;
        }
      }
    }
  }
  addBarrelUses(bucketImports);
  return { violations, uses };
}

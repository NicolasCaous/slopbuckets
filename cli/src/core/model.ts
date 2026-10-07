// The joined view of the folder scan and the adapter response that every rule reads.
import type { DmzExport } from '@slopbuckets/adapter-ts';
import { NO_SCRIPTS, type ScriptValues } from './bucket-glob.js';
import type { ResolvedConfig } from './config.js';
import type { LinkedAnalyzeResponse } from './types.js';
import { codeBucket, splitBucketPath } from './paths.js';
import type { Layout } from './scan.js';

export interface Model {
  config: ResolvedConfig;
  layout: Layout;
  response: LinkedAnalyzeResponse;
  dmzExtension: string;
  /** Exports of every analyzed DMZ file, by file and then by symbol name. */
  exports: Map<string, Map<string, DmzExport>>;
  /** Registered link folders (`<bucket>/_/links/<name>`). */
  links: ReadonlySet<string>;
  /** The alias of the origin of each registered link, and whether the link folder is on disk. */
  linkInfo: ReadonlyMap<string, LinkInfo>;
  /**
   * Links that the approved lock lists but buckets.links.json no longer does (`buckets link remove` ran, and no human
   * approved the removal yet): the alias of each origin, mapped to the link path.
   */
  removedLinks: ReadonlyMap<string, string>;
  /** The values of the scripts of the config, which the access lines may name. */
  scripts: ScriptValues;
}

export interface LinkInfo {
  alias: string;
  present: boolean;
}

export function buildModel(
  config: ResolvedConfig,
  layout: Layout,
  response: LinkedAnalyzeResponse,
  dmzExtension: string,
  links: ReadonlySet<string> = new Set(),
  linkInfo: ReadonlyMap<string, LinkInfo> = new Map(),
  removedLinks: ReadonlyMap<string, string> = new Map(),
  scripts: ScriptValues = NO_SCRIPTS,
): Model {
  const exports = new Map<string, Map<string, DmzExport>>();
  for (const file of layout.dmzFiles.keys()) {
    const byName = new Map<string, DmzExport>();
    for (const entry of response.dmz[file]?.exports ?? []) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
    exports.set(file, byName);
  }
  return { config, layout, response, dmzExtension, exports, links, linkInfo, removedLinks, scripts };
}

function within(file: string, folder: string): boolean {
  return file === folder || file.startsWith(`${folder}/`);
}

/** The nested project folder that contains `file`, or null. A parent project never imports from a nested one. */
export function nestedProjectOf(model: Model, file: string): string | null {
  return model.layout.nestedProjects.find((p) => within(file, p)) ?? null;
}

/** The registered link folder that contains `file`, or null. */
export function linkOf(model: Model, file: string): string | null {
  for (const link of model.links) if (within(file, link)) return link;
  return null;
}

/** The registered link whose origin alias starts the import specifier `spec` (`<alias>/...`), or null. */
export function linkOfAlias(model: Model, spec: string): string | null {
  for (const [link, info] of model.linkInfo) if (spec === info.alias || spec.startsWith(`${info.alias}/`)) return link;
  return null;
}

/** The removed link whose origin alias starts the import specifier `spec`, with that alias, or null. */
export function removedLinkOfAlias(model: Model, spec: string): { alias: string; link: string } | null {
  for (const [alias, link] of model.removedLinks) if (spec === alias || spec.startsWith(`${alias}/`)) return { alias, link };
  return null;
}

/**
 * True when `file`, a project path inside the link folder `link`, is one of the origin's published files: a
 * `.external` file that the adapter reported exports for, or any file with the shape `<bucket path>/dmz/<child>/
 * .external<ext>` inside the link (a link mirrors the origin's root folder).
 */
export function isPublishedLinkFile(model: Model, link: string, file: string): boolean {
  if (!file.startsWith(`${link}/`)) return false;
  if (model.response.links?.[link]?.exports.some((e) => e.file === file)) return true;
  const parts = file.slice(link.length + 1).split('/');
  if (parts.length < 3 || parts[parts.length - 3] !== 'dmz') return false;
  if (parts[parts.length - 1] !== `.external${model.dmzExtension}`) return false;
  return parts.slice(0, -3).every((s) => s !== '_' && s !== 'dmz' && s !== '');
}

/** True when the project path is a DMZ file by its location (`X/dmz/...`), whether or not its path is valid. */
export function isDmzLocation(model: Model, file: string): boolean {
  return splitBucketPath(model.config.root, file)?.area === 'dmz';
}

/**
 * Converts a project file path to the alias import specifier the AI should write, without extension.
 * The alias only reaches files under the root folder, so any other path comes back unchanged.
 */
export function toSpecifier(model: Model, file: string): string {
  const root = model.config.root;
  if (!file.startsWith(`${root}/`)) return file;
  let rest = file.slice(root.length + 1);
  const dot = rest.lastIndexOf('.');
  const slash = rest.lastIndexOf('/');
  if (dot > slash + 1) rest = rest.slice(0, dot);
  // A declaration file (`index.d.ts`, `x.d.mts`) is imported without the `.d` part as well.
  if (/\.d\.[cm]?ts$/.test(file) && rest.endsWith('.d')) rest = rest.slice(0, -2);
  return `${model.config.alias}/${rest}`;
}

export interface Origin {
  /** Bucket whose `_/` declares the symbol, or `null` when the chain is broken. */
  bucket: string | null;
  /** Files from the starting DMZ file to the declaring file. */
  chain: string[];
}

/** Follows the re-export chain of `name` starting at the DMZ file `file` until it reaches a `_/` file. */
export function resolveOrigin(model: Model, file: string, name: string): Origin {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = file;
  for (;;) {
    chain.push(current);
    const bucket = codeBucket(model.config.root, current);
    if (bucket !== null) return { bucket, chain };
    if (seen.has(current)) return { bucket: null, chain };
    seen.add(current);
    const entry = model.exports.get(current)?.get(name);
    if (!entry) return { bucket: null, chain };
    current = entry.from;
  }
}

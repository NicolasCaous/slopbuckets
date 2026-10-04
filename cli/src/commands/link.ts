// `buckets link`: consume the source of another project (`add`, `sync`, `update`, `remove`). A link is a junction
// (or folder symlink) to the origin's root folder, or a copy of the files its `.external.ts` files reach. The commands
// write buckets.links.json, the link folders, .gitignore and the `paths` entry of the origin's alias in tsconfig.json.
// They never write buckets.lock.json: a new, changed or removed link fails the check with exit code 2 until a human
// approves it with `buckets refresh`.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type ResolvedConfig } from '../core/config.js';
import {
  LINK_NAME,
  LINKS_FILE,
  linkClosure,
  linkLocation,
  linkPath,
  linkState,
  loadOrigin,
  materializeLinkAt,
  originShapeProblem,
  originSource,
  parseLinkPath,
  publishedFiles,
  readLinksManifest,
  removeLinkAt,
  storedOrigin,
  updateGitignore,
  writeLinksManifest,
  type LinkMode,
  type LinkRequest,
} from '../core/links.js';
import { CONFIG_FILE, relativeToProject, splitBucketPath, toPosix } from '../core/paths.js';
import { findProjectDir } from '../core/project.js';
import { discoverProjects } from '../core/recursive.js';
import { scanProject } from '../core/scan.js';
import { addLinkExclude, addLinkPath, bundlerInstructions, removeLinkExclude, removeLinkPath, TSCONFIG, type ExcludeEdit, type TsconfigEdit } from '../core/tsconfig-paths.js';
import type { Context } from '../core/types.js';
import type { Io } from './io.js';

export const LINK_USAGE = `Usage:
  buckets link add <name> <origin project folder> [--bucket <path>] [--copy]
  buckets link sync [--no-recursive]
  buckets link update [<name>] [--bucket <path>]
  buckets link remove <name> [--bucket <path>]
`;

const APPROVAL = 'The check fails with exit code 2 until a human approves the change with `buckets refresh` (an agent asks with `buckets refresh --web`).';

interface Project {
  dir: string;
  config: ResolvedConfig;
}

class LinkError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

function loadProject(io: Io): Project {
  const dir = findProjectDir(io.cwd);
  if (dir === null) throw new LinkError(`No ${CONFIG_FILE} in ${io.cwd} or any parent folder. Run the command inside a slopbuckets project, or run \`buckets init\` first.`);
  const config = loadConfig(dir);
  if (config.kind !== 'ok') {
    throw new LinkError(`${CONFIG_FILE} in ${dir} is ${config.kind === 'missing' ? 'missing' : 'invalid'}. Run \`buckets check\` to see why, fix it, and try again.`);
  }
  return { dir, config: config.config };
}

function manifestOf(project: Project): Record<string, LinkRequest> {
  const manifest = readLinksManifest(project.dir);
  if (manifest.kind === 'invalid') throw new LinkError(`${LINKS_FILE} cannot be read: ${manifest.reason}. Fix it by hand, then run the command again.`);
  return manifest.kind === 'ok' ? { ...manifest.links } : {};
}

function isFolder(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** The bucket of `--bucket <path>`, or of the current folder. */
function resolveBucket(project: Project, io: Io, bucketArg: string | undefined): string {
  const abs = path.resolve(io.cwd, bucketArg ?? '.');
  const rel = relativeToProject(project.dir, abs);
  const fromCwd = toPosix(path.relative(io.cwd, path.join(project.dir, project.config.root))) || '.';
  const example = `${fromCwd === '.' ? '' : `${fromCwd}/`}<bucket>`;
  if (bucketArg !== undefined && !isFolder(abs)) {
    throw new LinkError(
      `--bucket ${bucketArg} names ${rel ?? toPosix(abs)}, which does not exist. --bucket is relative to the current folder (${toPosix(io.cwd)}), not to the project. Pass the path of a bucket folder from here, such as ${example}.`,
    );
  }
  const split = rel === null ? null : splitBucketPath(project.config.root, rel);
  if (split === null || findProjectDir(abs) !== project.dir) {
    throw new LinkError(
      bucketArg === undefined
        ? `The current folder is not inside a bucket of ${project.dir}. Run the command inside the bucket that uses the link (for example in ${project.config.root}/<bucket>/), or pass --bucket <path to the bucket folder>.`
        : `${bucketArg} is not a bucket folder of ${project.dir}. Pass the path of a bucket folder under ${project.config.root}/, relative to the current folder, such as ${example}.`,
    );
  }
  if (!existsSync(path.join(project.dir, split.bucket, '_'))) {
    throw new LinkError(`The bucket ${split.bucket}/ has no _/ folder. Create ${split.bucket}/_/ first: links live in ${split.bucket}/_/links/.`);
  }
  return split.bucket;
}

/** The registered link named `name`: in the given or current bucket when there is one, or the only link with that name. */
function findLink(project: Project, io: Io, links: Record<string, LinkRequest>, name: string, bucketArg: string | undefined): string {
  let bucket: string | null = null;
  try {
    bucket = resolveBucket(project, io, bucketArg);
  } catch (error) {
    if (bucketArg !== undefined) throw error;
  }
  if (bucket !== null && links[linkPath(bucket, name)] !== undefined) return linkPath(bucket, name);
  const matches = Object.keys(links).filter((p) => p.endsWith(`/_/links/${name}`));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const known = Object.keys(links);
    throw new LinkError(`No link named "${name}" in ${LINKS_FILE}.${known.length > 0 ? ` The registered links are: ${known.join(', ')}.` : ' The project has no links.'}`);
  }
  throw new LinkError(`More than one bucket has a link named "${name}": ${matches.join(', ')}. Run the command inside the bucket, or pass --bucket <path>.`);
}

function parseFlags(args: string[], allowed: { bucket?: boolean; copy?: boolean; recursive?: boolean }): { positional: string[]; bucket?: string; copy: boolean; recursive: boolean } {
  const positional: string[] = [];
  let bucket: string | undefined;
  let copy = false;
  let recursive = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (allowed.bucket && arg === '--bucket') {
      bucket = args[++i];
      if (bucket === undefined) throw new LinkError(`--bucket needs a path.\n${LINK_USAGE}`);
    } else if (allowed.bucket && arg.startsWith('--bucket=')) bucket = arg.slice('--bucket='.length);
    else if (allowed.copy && arg === '--copy') copy = true;
    else if (allowed.recursive && arg === '--no-recursive') recursive = false;
    else if (arg.startsWith('-')) throw new LinkError(`unknown option "${arg}".\n${LINK_USAGE}`);
    else positional.push(arg);
  }
  return { positional, ...(bucket !== undefined ? { bucket } : {}), copy, recursive };
}

/** The buckets the scan finds in a project, the only places where a link folder may be created or deleted. */
function scannedBuckets(ctx: Context, dir: string, config: ResolvedConfig, links: Record<string, LinkRequest>): Set<string> {
  const info = ctx.adapter.info();
  const layout = scanProject(dir, config, { extensions: info.extensions, dmzExtension: info.dmzExtension, links: new Set(Object.keys(links)) });
  return new Set(layout.buckets.keys());
}

/** Why a registered link path cannot hold a link, or null. */
function linkPathProblem(p: string, buckets: ReadonlySet<string>): string | null {
  const parsed = parseLinkPath(p);
  if (parsed === null) return `${p} is not a link path of the form <bucket>/_/links/<name>`;
  if (!buckets.has(parsed.bucket)) return `${p} names ${parsed.bucket}, which is not a bucket of this project`;
  return null;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The text that reports a tsconfig.json edit, ending with a line feed. */
function tsconfigReport(edit: TsconfigEdit, adding: boolean): string {
  switch (edit.status) {
    case 'added':
      return `Added ${edit.line} to "compilerOptions.paths" in ${TSCONFIG}.\n`;
    case 'updated':
      return `Pointed ${edit.line} in "compilerOptions.paths" of ${TSCONFIG} at the link (it pointed elsewhere).\n`;
    case 'unchanged':
      return `${TSCONFIG} already maps the alias: ${edit.line}.\n`;
    case 'removed':
      return `Removed ${edit.line} from "compilerOptions.paths" in ${TSCONFIG}.\n`;
    case 'absent':
      return '';
    case 'manual':
      return adding
        ? `Did not edit ${TSCONFIG}, because ${edit.reason}. Add this entry to "compilerOptions.paths" of the config that compiles the bucket code:\n  ${edit.line}\n`
        : `Did not edit ${TSCONFIG}, because ${edit.reason}. Remove this entry from "compilerOptions.paths" by hand if it is there:\n  ${edit.line}\n`;
  }
}

/** The text that reports the `exclude` edit of a link folder, ending with a line feed. */
function excludeReport(edit: ExcludeEdit, linkRel: string, adding: boolean): string {
  switch (edit.status) {
    case 'added':
      return edit.line.startsWith('"exclude"')
        ? `Added ${edit.line} to ${TSCONFIG}, so \`tsc\` here compiles only the linked files that code imports, not the whole linked project.\n`
        : `Added ${edit.line} to "exclude" in ${TSCONFIG}, so \`tsc\` here compiles only the linked files that code imports, not the whole linked project.\n`;
    case 'unchanged':
      return `${TSCONFIG} already excludes ${linkRel}.\n`;
    case 'removed':
      return `Removed ${edit.line} from "exclude" in ${TSCONFIG}.\n`;
    case 'absent':
      return '';
    case 'manual':
      return adding
        ? edit.line.startsWith('"exclude"')
          ? `Did not edit ${TSCONFIG}, because ${edit.reason}. Add this line at the top level of the config that compiles the bucket code, so \`tsc\` does not compile the whole linked project:\n  ${edit.line}\n`
          : `Did not edit ${TSCONFIG}, because ${edit.reason}. Add this entry to the "exclude" array of the config that compiles the bucket code, so \`tsc\` does not compile the whole linked project:\n  ${edit.line}\n`
        : `Did not edit ${TSCONFIG}, because ${edit.reason}. Remove this entry from "exclude" by hand if it is there:\n  ${edit.line}\n`;
  }
}

const ABSOLUTE_ORIGIN =
  'The origin is on another drive, so buckets.links.json and the lock store its absolute path. That path only works on this machine: other clones need the origin at the same path, or `buckets link sync` reports it as missing.';

async function addLink(ctx: Context, io: Io, args: string[]): Promise<number> {
  const flags = parseFlags(args, { bucket: true, copy: true });
  if (flags.positional.length !== 2) throw new LinkError(`buckets link add needs a name and the folder of the origin project.\n${LINK_USAGE}`);
  const [name, originArg] = flags.positional as [string, string];
  if (!LINK_NAME.test(name)) throw new LinkError(`"${name}" is not a valid link name. Use letters, digits, ".", "_" and "-", starting with a letter or digit.`);
  const project = loadProject(io);
  const bucket = resolveBucket(project, io, flags.bucket);
  const ext = ctx.adapter.info().dmzExtension;

  const originAbs = path.resolve(io.cwd, originArg);
  const origin = loadOrigin(originAbs);
  if ('problem' in origin) {
    // A folder or a published file inside a project: name the project folder to pass instead.
    const enclosing = findProjectDir(originAbs);
    if (enclosing !== null && path.relative(enclosing, originAbs) !== '' && path.relative(enclosing, project.dir) !== '') {
      const rel = toPosix(path.relative(io.cwd, enclosing)) || '.';
      throw new LinkError(
        originShapeProblem(originAbs) !== null
          ? `Cannot link ${originArg}: it names a published .external file, but a link takes a whole project. Pass the folder of the origin project, ${rel}, which holds its ${CONFIG_FILE}.`
          : `Cannot link ${originArg}: it is inside the slopbuckets project ${rel}. Pass that folder, which holds its ${CONFIG_FILE}: a link takes the whole project, and code imports only its published .external files.`,
      );
    }
    throw new LinkError(`Cannot link ${originArg}: ${origin.problem}.`);
  }
  if (inside(origin.dir, project.dir) && inside(project.dir, origin.dir)) {
    throw new LinkError(`${originArg} is this same project. Buckets of one project share code through DMZ contracts; links connect different projects.`);
  }
  // A project nested in the origin's root folder gets a copy: a junction to that folder would contain itself.
  const enclosed = inside(project.dir, origin.rootAbs);

  const links = manifestOf(project);
  const alias = origin.config.alias;
  const how = `Change the alias of one of the two projects: edit "alias" in its ${CONFIG_FILE}, update its imports and its ${TSCONFIG} paths (\`buckets init\` sets the paths), and have a human approve that change. \`buckets init\` gives new projects a unique alias such as @root-k3x9pm2a.`;
  if (alias === project.config.alias) {
    throw new LinkError(`The project ${originArg} uses the alias ${alias}, which is also the alias of this project. Imports of ${alias}/... could not tell the two projects apart. ${how}`);
  }
  const clash = Object.entries(links).find(([, request]) => request.alias === alias);
  const sameOrigin = (existing: string, wanted: string): string => {
    const owner = parseLinkPath(existing)?.bucket ?? existing;
    const existingName = existing.slice(existing.lastIndexOf('/') + 1);
    return owner === wanted
      ? `Code in ${wanted}/_/ already imports it through ${alias}.`
      : `Code in ${owner}/_/ imports it. To use it in ${wanted}, re-export the symbols ${wanted} needs from ${owner} through a DMZ contract, or move the link: run \`buckets link remove ${existingName}\` and add it in ${wanted} instead.`;
  };
  if (clash !== undefined) {
    throw new LinkError(
      `The alias ${alias} of ${originArg} is already the alias of the link ${clash[0]} (origin ${clash[1].origin}). One alias can map to one folder only, so a project can be linked once per consumer project. ${clash[1].origin === storedOrigin(project.dir, origin.dir).origin ? sameOrigin(clash[0], bucket) : how}`,
    );
  }

  const target = linkPath(bucket, name);
  const targetAbs = path.join(project.dir, target);
  if (links[target] !== undefined) throw new LinkError(`${target} is already registered in ${LINKS_FILE}. Use \`buckets link update ${name}\` to copy it again, or \`buckets link remove ${name}\` first.`);
  if (linkState(targetAbs) !== 'missing') throw new LinkError(`${target} already exists on disk. Delete it or choose another name.`);

  const buckets = scannedBuckets(ctx, project.dir, project.config, links);
  if (!buckets.has(bucket)) throw new LinkError(`${bucket}/ is not a bucket that buckets check scans (it may be deeper than maxDepth). Links live in the _/links/ folder of a bucket.`);
  const published = publishedFiles(origin.rootAbs, ext);
  const { origin: stored, absolute } = storedOrigin(project.dir, origin.dir);
  let mode: LinkMode;
  try {
    mode = materializeLinkAt(project.dir, target, buckets, { rootAbs: origin.rootAbs, files: linkClosure(origin.rootAbs, alias, ext) }, flags.copy ? 'copy' : 'link');
  } catch (error) {
    throw new LinkError(`Cannot create ${target}: ${error instanceof Error ? error.message : String(error)}.`);
  }
  links[target] = { origin: stored, mode, alias };
  writeLinksManifest(project.dir, links);
  if (mode === 'link') updateGitignore(project.dir, target, true);

  const rootRel = toPosix(path.relative(project.dir, origin.rootAbs));
  let out =
    mode === 'link'
      ? `Created ${target} as a ${process.platform === 'win32' ? 'junction' : 'folder symlink'} to ${rootRel}/ and added it to .gitignore. Other clones recreate it with \`buckets link sync\`.\n`
      : `Copied the published files of ${rootRel}/ and every file they import to ${target}${flags.copy ? '' : enclosed ? `, because this project lives inside ${rootRel}/ and a link to that folder would contain this project` : ', because a link could not be created here'}. Commit the copy; \`buckets link update ${name}\` copies the origin again.\n`;
  out += `Registered it in ${LINKS_FILE} with the alias ${alias}.\n`;
  out += tsconfigReport(addLinkPath(project.dir, alias, target), true);
  out += excludeReport(addLinkExclude(project.dir, target), target, true);
  const bundlers = bundlerInstructions(project.dir, alias, target);
  if (bundlers.length > 0) out += `Bundler configs found. slopbuckets does not edit them; add the alias yourself:\n${bundlers.map((b) => `  ${b.replace(/\n/g, '\n  ')}`).join('\n')}\n`;
  if (published.length === 0) {
    out += `${originArg} publishes nothing yet: it has no <parent>/dmz/<bucket>/.external${ext} file. Code here can import only those files, so the origin project must add one first.\n`;
  } else {
    const specs = published.map((f) => `${alias}/${f.slice(0, -ext.length)}`);
    out += `Code in ${bucket}/_/ imports the linked project only through its published files: ${specs.map((s) => `'${s}'`).join(', ')}. Values and types are both allowed. Importing any other file of the link fails the check with link-forbidden-import.\n`;
  }
  const originRel = toPosix(path.relative(project.dir, origin.dir)) || '.';
  out +=
    mode === 'link'
      ? `The packages the linked files import must resolve in two places. At runtime, Node and bundlers follow the link and load them from the origin: run \`npm install\` in ${originRel}. For type checking, \`tsc\` here reads the linked files through the link path and looks the packages up from this project: install each one (or its @types package) in this project too, for example as a devDependency. \`buckets check\` reports a missing one as link-missing-dependency and says which side lacks it.\n`
      : `The packages the linked files import must resolve from this project, both for type checking and at runtime: add them to this project's package.json. \`buckets check\` reports a missing one as link-missing-dependency.\n`;
  out += `${APPROVAL}\n`;
  io.stdout(out);
  if (absolute) io.stderr(`Warning: ${ABSOLUTE_ORIGIN}\n`);
  return 0;
}

async function syncLinks(ctx: Context, io: Io, args: string[]): Promise<number> {
  const flags = parseFlags(args, { recursive: true });
  if (flags.positional.length > 0) throw new LinkError(`buckets link sync takes no names.\n${LINK_USAGE}`);
  const start = loadProject(io);
  const ext = ctx.adapter.info().dmzExtension;
  let failed = 0;
  let created = 0;
  for (const { path: rel, dir } of discoverProjects(ctx, start.dir, flags.recursive)) {
    const manifest = readLinksManifest(dir);
    if (manifest.kind === 'invalid') {
      io.stderr(`${rel}/${LINKS_FILE} cannot be read: ${manifest.reason}. Fix it, then run \`buckets link sync\` again.\n`);
      failed++;
      continue;
    }
    if (manifest.kind === 'missing') continue;
    const config = loadConfig(dir);
    if (config.kind !== 'ok') {
      io.stderr(`${rel}/${CONFIG_FILE} is missing or invalid, so its links were not synced. Run \`buckets check\` to see why.\n`);
      failed++;
      continue;
    }
    const buckets = scannedBuckets(ctx, dir, config.config, manifest.links);
    const prefix = rel === '.' ? '' : `${rel}/`;
    for (const [p, request] of Object.entries(manifest.links).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const problem = linkPathProblem(p, buckets);
      if (problem !== null) {
        io.stderr(`Skipped ${prefix}${p}: ${problem}. Fix ${prefix}${LINKS_FILE}, then run \`buckets link sync\` again.\n`);
        failed++;
        continue;
      }
      const state = linkState(path.join(dir, p));
      if (state === 'link' || state === 'copy') continue;
      if (state === 'file') {
        io.stderr(`${prefix}${p} is a file, not a link folder. Delete it, then run \`buckets link sync\` again.\n`);
        failed++;
        continue;
      }
      const source = originSource(dir, request, ext);
      if ('problem' in source) {
        io.stderr(`Cannot create ${prefix}${p}: ${source.problem}. Make the origin project available at ${request.origin}, then run \`buckets link sync\` again.\n`);
        failed++;
        continue;
      }
      let mode: LinkMode;
      try {
        if (state === 'dangling') removeLinkAt(dir, p, buckets);
        mode = materializeLinkAt(dir, p, buckets, source, request.mode);
      } catch (error) {
        io.stderr(`Cannot create ${prefix}${p}: ${error instanceof Error ? error.message : String(error)}.\n`);
        failed++;
        continue;
      }
      created++;
      io.stdout(`Created ${prefix}${p} (${mode === 'link' ? 'link' : 'copy'} of the project ${request.origin}).\n`);
      if (mode !== request.mode) {
        io.stderr(`${prefix}${p} is registered as a link, but a link could not be created here, so it is a copy. Do not commit it; delete it and run \`buckets link sync\` where links work.\n`);
      }
    }
  }
  io.stdout(created === 0 && failed === 0 ? 'Every link in buckets.links.json is present. Nothing to do.\n' : '');
  return failed > 0 ? 1 : 0;
}

async function updateLinks(ctx: Context, io: Io, args: string[]): Promise<number> {
  const flags = parseFlags(args, { bucket: true });
  if (flags.positional.length > 1) throw new LinkError(`buckets link update takes at most one name.\n${LINK_USAGE}`);
  const project = loadProject(io);
  const links = manifestOf(project);
  const ext = ctx.adapter.info().dmzExtension;
  const name = flags.positional[0];
  let selected: string[];
  if (name !== undefined) {
    const p = findLink(project, io, links, name, flags.bucket);
    if (links[p]!.mode !== 'copy') {
      io.stdout(`${p} is a link, so it already shows the current source of its origin. Nothing to copy. If a published signature changed, a human approves it with \`buckets refresh\`.\n`);
      return 0;
    }
    selected = [p];
  } else {
    selected = Object.keys(links).filter((p) => links[p]!.mode === 'copy').sort();
    if (selected.length === 0) {
      io.stdout('The project has no links in copy mode. Nothing to update.\n');
      return 0;
    }
  }
  let failed = 0;
  const buckets = scannedBuckets(ctx, project.dir, project.config, links);
  for (const p of selected) {
    const request = links[p]!;
    const problem = linkPathProblem(p, buckets);
    if (problem !== null) {
      io.stderr(`Cannot update ${p}: ${problem}. Fix ${LINKS_FILE}, then run the command again.\n`);
      failed++;
      continue;
    }
    const source = originSource(project.dir, request, ext);
    if ('problem' in source) {
      io.stderr(`Cannot update ${p}: ${source.problem}. The committed copy stays as it is.\n`);
      failed++;
      continue;
    }
    if (source.origin.config.alias !== request.alias) {
      io.stderr(
        `Cannot update ${p}: the origin project now uses the alias ${source.origin.config.alias}, but the link was added with ${request.alias}. Remove the link with \`buckets link remove\` and add it again, then update the imports that use ${request.alias}.\n`,
      );
      failed++;
      continue;
    }
    try {
      // Checked before anything is deleted, so a refused location keeps its content.
      linkLocation(project.dir, p, buckets);
      removeLinkAt(project.dir, p, buckets);
      materializeLinkAt(project.dir, p, buckets, source, 'copy');
    } catch (error) {
      io.stderr(`Cannot update ${p}: ${error instanceof Error ? error.message : String(error)}.\n`);
      failed++;
      continue;
    }
    io.stdout(`Copied the project ${request.origin} to ${p} again (${source.files.length} ${source.files.length === 1 ? 'file' : 'files'}).\n`);
  }
  if (selected.length > failed) io.stdout(`Run \`buckets check\` to see whether the code that uses the link still passes. A changed published signature needs approval. ${APPROVAL}\n`);
  return failed > 0 ? 1 : 0;
}

async function removeLink(ctx: Context, io: Io, args: string[]): Promise<number> {
  const flags = parseFlags(args, { bucket: true });
  if (flags.positional.length !== 1) throw new LinkError(`buckets link remove needs the name of a link.\n${LINK_USAGE}`);
  const project = loadProject(io);
  const links = manifestOf(project);
  const p = findLink(project, io, links, flags.positional[0]!, flags.bucket);
  const request = links[p]!;
  const buckets = scannedBuckets(ctx, project.dir, project.config, links);
  // An entry that does not point into a bucket's _/links/ only loses its manifest entry; nothing on disk is deleted.
  let kept = '';
  try {
    removeLinkAt(project.dir, p, buckets);
  } catch (error) {
    kept = ` Nothing on disk was deleted, because ${error instanceof Error ? error.message : String(error)}.`;
  }
  delete links[p];
  writeLinksManifest(project.dir, links);
  if (request.mode === 'link' && parseLinkPath(p) !== null) updateGitignore(project.dir, p, false);
  let out = `Removed ${kept === '' ? `${p} and ` : ''}its entry in ${LINKS_FILE}.${kept}\n`;
  if (parseLinkPath(p) !== null) {
    out += tsconfigReport(removeLinkPath(project.dir, request.alias, p), false);
    out += excludeReport(removeLinkExclude(project.dir, p), p, false);
  }
  out += `Remove the imports of ${request.alias} from the code, and the alias from any bundler config. ${APPROVAL}\n`;
  io.stdout(out);
  return 0;
}

export async function linkCommand(ctx: Context, io: Io, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'add':
        return await addLink(ctx, io, rest);
      case 'sync':
        return await syncLinks(ctx, io, rest);
      case 'update':
        return await updateLinks(ctx, io, rest);
      case 'remove':
        return await removeLink(ctx, io, rest);
      default:
        io.stderr(
          `buckets link: ${sub === undefined ? 'missing subcommand' : sub === 'build' ? '"build" no longer exists: links carry the source of the origin project, so there is nothing to generate' : `unknown subcommand "${sub}"`}.\n${LINK_USAGE}`,
        );
        return 1;
    }
  } catch (error) {
    if (error instanceof LinkError) {
      io.stderr(`buckets link ${sub}: ${error.message}\n`);
      return error.code;
    }
    throw error;
  }
}

// Folder rules: walks the bucket tree, validates its shape and DMZ paths, and collects the files the adapter analyzes.
import { existsSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from './config.js';
import { classifyDmzPath, EXTERNAL, type DmzFile } from './dmz-path.js';
import { listDir, listFilesRecursive } from './fs-walk.js';
import { layoutViolation } from './rules/layout.js';
import { CONFIG_FILE } from './paths.js';
import type { Violation } from './types.js';

export interface Bucket {
  path: string;
  name: string;
  level: number;
  parent: string | null;
  /** Names of the child buckets. */
  children: string[];
  hasCode: boolean;
  hasDmz: boolean;
}

export interface Layout {
  /** Buckets by project path, in tree order. */
  buckets: Map<string, Bucket>;
  /** DMZ files with a valid path, by project path. */
  dmzFiles: Map<string, DmzFile>;
  /** Code files under `X/_/` with an extension the adapter analyzes, sorted. */
  codeFiles: string[];
  /** The other files under `X/_/`, sorted. They can change how imports resolve, so the analysis cache hashes their names. */
  otherFiles: string[];
  /** Nested projects: folders under some `X/_/` that hold a buckets.config.json. Project paths, sorted. */
  nestedProjects: string[];
  violations: Violation[];
}

export interface ScanOptions {
  extensions: string[];
  dmzExtension: string;
  /** Registered link folders (`<bucket>/_/links/<name>`). The scan accepts them as links and never enters them. */
  links?: ReadonlySet<string>;
}

function misplacedViolation(config: ResolvedConfig, file: string): Violation {
  return {
    rule: 'project-misplaced',
    file,
    message: `${file} makes its folder a slopbuckets project in a place where projects are not allowed. Inside ${config.root}/ a nested project may live only in a subfolder of a bucket's _/ folder, such as ${config.root}/<bucket>/_/<name>/${CONFIG_FILE}. Move the project folder into the _/ of the bucket that owns it, or delete ${file} if the folder is not meant to be a project.`,
  };
}

function symlinkViolation(config: ResolvedConfig, file: string): Violation {
  return {
    rule: 'folder-symlink',
    file,
    message: `${file} is a symbolic link or junction. slopbuckets does not follow links inside ${config.root}/, because a link can put the same code in two buckets or pull in code from outside the project without an import the check can see. Replace the link with a real file or folder, or move the linked code into the _/ of the bucket that owns it.`,
  };
}

/** True when `abs` itself is a link. Junctions count as links. */
function isLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when the link at `abs` resolves to a folder. Used only to classify the link; the scan never enters it. */
function pointsToDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** Extensions are compared without case, so `A.TS` is analyzed like `a.ts`. */
function hasExtension(file: string, extensions: string[]): boolean {
  const lower = file.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

/** Compiler outputs and the source extensions that produce them. A `.map` file follows its output. */
const EMITTED: [RegExp, string[]][] = [
  [/\.d\.ts(\.map)?$/i, ['.ts', '.tsx']],
  [/\.d\.mts(\.map)?$/i, ['.mts']],
  [/\.d\.cts(\.map)?$/i, ['.cts']],
  [/\.(js|jsx|mjs|cjs)(\.map)?$/i, ['.ts', '.tsx', '.mts', '.cts']],
];

/**
 * Removes compiler output that sits next to its source: `x.js`, `x.mjs`, `x.cjs`, `x.jsx` or `x.d.ts`
 * (and their `.map` files) when the same folder has `x.ts`, `x.tsx`, `x.mts` or `x.cts`. `tsc` without
 * `outDir` writes them there. The scan drops them, before the adapter sees any file, so they neither
 * repeat every import of their source nor break the DMZ path rules. A hand-written JavaScript file with
 * no TypeScript source of the same name is still checked. `files` are `/`-separated relative paths.
 */
export function withoutEmittedFiles(files: string[]): string[] {
  const present = new Set(files.map((f) => f.toLowerCase()));
  return files.filter((file) => {
    for (const [pattern, sources] of EMITTED) {
      const match = pattern.exec(file);
      if (match === null) continue;
      const base = file.slice(0, match.index).toLowerCase();
      return !sources.some((ext) => present.has(base + ext));
    }
    return true;
  });
}

export function scanProject(projectDir: string, config: ResolvedConfig, options: ScanOptions): Layout {
  const layout: Layout = { buckets: new Map(), dmzFiles: new Map(), codeFiles: [], otherFiles: [], nestedProjects: [], violations: [] };
  const rootAbs = path.join(projectDir, config.root);
  if (isLink(rootAbs)) {
    layout.violations.push(symlinkViolation(config, config.root));
    return layout;
  }
  if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    layout.violations.push({
      rule: 'folder-missing-code',
      file: config.root,
      message: `The root bucket folder ${config.root}/ does not exist. Create ${config.root}/_/ for the root code, or fix "root" in buckets.config.json.`,
    });
    return layout;
  }
  // The root bucket always exists, so a layout that forbids it is reported and the scan goes on.
  const rootDenied = layoutViolation(config, config.root, null);
  if (rootDenied !== null) layout.violations.push(rootDenied);
  visitBucket(projectDir, config, options, layout, config.root, null, 0);
  layout.codeFiles.sort();
  layout.otherFiles.sort();
  layout.nestedProjects.sort();
  return layout;
}

function visitBucket(
  projectDir: string,
  config: ResolvedConfig,
  options: ScanOptions,
  layout: Layout,
  bucketPath: string,
  parent: string | null,
  level: number,
): void {
  const abs = path.join(projectDir, bucketPath);
  const name = bucketPath.slice(bucketPath.lastIndexOf('/') + 1);
  const bucket: Bucket = { path: bucketPath, name, level, parent, children: [], hasCode: false, hasDmz: false };
  layout.buckets.set(bucketPath, bucket);
  const childNames: string[] = [];
  // Folders the layout forbids and linked folders are not buckets, but they still count as children for the DMZ rules,
  // so a single misplaced folder gives one violation (layout-denied or folder-symlink) instead of a cascade of DMZ errors.
  const notBuckets: string[] = [];
  let linkedCode = false;

  for (const entry of listDir(abs)) {
    const entryPath = `${bucketPath}/${entry.name}`;
    if (entry.isSymlink) {
      layout.violations.push(symlinkViolation(config, entryPath));
      // A linked _/ still counts as present, so the link gives one violation instead of a second folder-missing-code.
      if (entry.name === '_') linkedCode = true;
      // A linked folder that looks like a child bucket still counts as one for the DMZ rules, like a forbidden folder.
      else if (entry.name !== 'dmz' && !entry.name.startsWith('.') && pointsToDir(path.join(abs, entry.name))) notBuckets.push(entry.name);
    } else if (!entry.isDir && entry.name === CONFIG_FILE) {
      layout.violations.push(misplacedViolation(config, entryPath));
    } else if (!entry.isDir) {
      layout.violations.push({
        rule: 'folder-loose-file',
        file: entryPath,
        message: `${entryPath} is a loose file in the bucket folder ${bucketPath}/. A bucket holds only _/, dmz/ and child buckets. Move the file into ${bucketPath}/_/ (code) or into ${bucketPath}/dmz/<provider>/<consumer> (contract).`,
      });
    } else if (entry.name === '_') {
      bucket.hasCode = true;
    } else if (entry.name === 'dmz') {
      bucket.hasDmz = true;
    } else if (entry.name.startsWith('.')) {
      layout.violations.push({
        rule: 'folder-invalid-name',
        file: entryPath,
        message: `${entryPath}/ is treated as a child bucket, but bucket names cannot start with ".". Rename it, or move its contents into ${bucketPath}/_/ if it is not meant to be a bucket.`,
      });
    } else if (existsSync(path.join(abs, entry.name, CONFIG_FILE))) {
      // A project folder at bucket level is opaque, like a folder the layout forbids: one violation, and it still counts as a child.
      layout.violations.push(misplacedViolation(config, `${entryPath}/${CONFIG_FILE}`));
      notBuckets.push(entry.name);
    } else {
      // A folder the layout forbids is opaque too: one violation for it, and none for the folders inside it.
      const denied = layoutViolation(config, entryPath, bucketPath);
      if (denied === null) {
        childNames.push(entry.name);
      } else {
        layout.violations.push(denied);
        notBuckets.push(entry.name);
      }
    }
  }

  bucket.children = childNames;

  if (!bucket.hasCode && !linkedCode) {
    layout.violations.push({
      rule: 'folder-missing-code',
      file: bucketPath,
      message: `The bucket ${bucketPath}/ has no _/ folder. Every bucket keeps its own code in _/. Create ${bucketPath}/_/.`,
    });
  } else if (bucket.hasCode) {
    const links = options.links;
    const isLink = (rel: string): boolean => links !== undefined && links.has(`${bucketPath}/_/${rel}`);
    const listing = listFilesRecursive(path.join(abs, '_'), { acceptLink: isLink, skipDir: isLink });
    for (const rel of listing.symlinks) layout.violations.push(symlinkViolation(config, `${bucketPath}/_/${rel}`));
    for (const rel of listing.projects) {
      if (rel === '') layout.violations.push(misplacedViolation(config, `${bucketPath}/_/${CONFIG_FILE}`));
      else layout.nestedProjects.push(`${bucketPath}/_/${rel}`);
    }
    for (const rel of withoutEmittedFiles(listing.files)) {
      if (hasExtension(rel, options.extensions)) layout.codeFiles.push(`${bucketPath}/_/${rel}`);
      else layout.otherFiles.push(`${bucketPath}/_/${rel}`);
    }
  }

  if (bucket.hasDmz) {
    const dmzChildren = [...childNames, ...notBuckets].sort();
    if (dmzChildren.length === 0) {
      layout.violations.push({
        rule: 'folder-unexpected-dmz',
        file: `${bucketPath}/dmz`,
        message: `The bucket ${bucketPath}/ has a dmz/ folder but no child buckets. A DMZ only connects the children of a bucket. Delete ${bucketPath}/dmz/ and use the parent bucket's DMZ instead.`,
      });
    } else {
      scanDmz(projectDir, config, options, layout, bucket, dmzChildren);
    }
  }

  for (const child of childNames) {
    visitBucket(projectDir, config, options, layout, `${bucketPath}/${child}`, bucketPath, level + 1);
  }
}

function scanDmz(projectDir: string, config: ResolvedConfig, options: ScanOptions, layout: Layout, bucket: Bucket, children: string[]): void {
  const owner = { path: bucket.path, children, isRoot: bucket.parent === null };
  // `dmz/<child>/.external/` is the folder of generated declarations that older slopbuckets versions wrote. Links now
  // carry source code, so the folder has no use: one violation for the folder instead of one per file in it.
  const isExternalFolder = (rel: string): boolean => {
    const parts = rel.split('/');
    return parts.length === 2 && parts[1] === EXTERNAL && children.includes(parts[0]!);
  };
  const listing = listFilesRecursive(path.join(projectDir, bucket.path, 'dmz'), {
    skipDir: (rel) => {
      if (!isExternalFolder(rel)) return false;
      const folder = `${bucket.path}/dmz/${rel}`;
      layout.violations.push({
        rule: 'dmz-path',
        file: folder,
        message: `${folder}/ holds declarations that older slopbuckets versions generated with \`buckets link build\`. Links now carry the source of the origin project, so nothing reads this folder. Delete ${folder}/ (keep ${folder}${options.dmzExtension}, which is what the bucket publishes).`,
      });
      return true;
    },
  });
  for (const rel of listing.symlinks) layout.violations.push(symlinkViolation(config, `${bucket.path}/dmz/${rel}`));
  for (const rel of listing.projects) layout.violations.push(misplacedViolation(config, `${bucket.path}/dmz/${rel === '' ? '' : `${rel}/`}${CONFIG_FILE}`));
  for (const rel of withoutEmittedFiles(listing.files)) {
    const result = classifyDmzPath(owner, rel, options.dmzExtension);
    if ('error' in result) {
      layout.violations.push({ rule: 'dmz-path', file: `${bucket.path}/dmz/${rel}`, message: result.error });
    } else {
      layout.dmzFiles.set(result.file, result);
    }
  }
}

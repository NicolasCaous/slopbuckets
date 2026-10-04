import { readdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './paths.js';

export interface Entry {
  name: string;
  /** A real folder. Always false for a link, even one that points at a folder. */
  isDir: boolean;
  /** A symbolic link or, on Windows, a junction. The walk never follows these. */
  isSymlink: boolean;
}

/**
 * Entries of a folder sorted by name. Links are reported as links and never resolved, so a walk cannot leave
 * the folder it started in or visit the same files twice. Node reports Windows junctions as symbolic links here.
 */
export function listDir(dir: string): Entry[] {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const isSymlink = entry.isSymbolicLink();
      return { name: entry.name, isDir: !isSymlink && entry.isDirectory(), isSymlink };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface RecursiveListing {
  /** Every regular file below the folder, as paths relative to it with `/` separators, sorted. */
  files: string[];
  /** Every link below the folder, relative in the same way. The walk does not descend into them. */
  symlinks: string[];
  /**
   * Folders that hold a buckets.config.json, relative in the same way, `''` for the walked folder itself.
   * A project folder below the walked one is opaque: the walk lists none of its files. When the walked folder
   * itself holds a config, the walk goes on and only leaves the config file out of `files`.
   */
  projects: string[];
}

export interface WalkOptions {
  /** Relative paths of links the caller accepts. They are left out of `symlinks` and never entered. */
  acceptLink?: (rel: string) => boolean;
  /** Relative paths of folders to leave out entirely. */
  skipDir?: (rel: string) => boolean;
}

/** Every file below `dir`, without following links and without entering nested project folders. */
export function listFilesRecursive(dir: string, options: WalkOptions = {}): RecursiveListing {
  const files: string[] = [];
  const symlinks: string[] = [];
  const projects: string[] = [];
  const visit = (abs: string, rel: string): void => {
    const entries = listDir(abs);
    if (entries.some((entry) => entry.name === CONFIG_FILE && !entry.isDir && !entry.isSymlink)) {
      projects.push(rel);
      if (rel !== '') return;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymlink) {
        if (!options.acceptLink?.(childRel)) symlinks.push(childRel);
      } else if (entry.isDir) {
        if (!options.skipDir?.(childRel)) visit(path.join(abs, entry.name), childRel);
      } else if (!(rel === '' && entry.name === CONFIG_FILE)) files.push(childRel);
    }
  };
  visit(dir, '');
  return { files, symlinks, projects };
}

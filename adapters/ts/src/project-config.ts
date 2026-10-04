// Settings that slopbuckets requires in tsconfig.json. `init` writes them and
// `analyze` reports when they are missing.

import path from 'node:path';
import type * as TS from 'typescript';
import { folderReach, type ProjectConfig } from './env.js';
import type { BucketsConfig } from './protocol.js';

export function aliasKey(config: BucketsConfig): string {
  return `${config.alias}/*`;
}

/**
 * The `paths` entry for the alias, written relative to the folder that `paths` resolves from:
 * `baseUrl` when it is set, the tsconfig folder (`configDir`) otherwise. Without `baseUrl`, TypeScript only
 * accepts targets that start with `./` or `../` (error TS5090), so the target gets a `./` prefix.
 */
export function expectedAliasTarget(projectDir: string, config: BucketsConfig, baseUrl: string | undefined, configDir = projectDir): string {
  const base = baseUrl === undefined ? configDir : path.resolve(projectDir, baseUrl);
  const relative = path.relative(base, path.resolve(projectDir, config.root)).split(path.sep).join('/');
  const target = `${relative === '' ? '.' : relative}/*`;
  return baseUrl === undefined && !isExplicitlyRelative(target) ? `./${target}` : target;
}

function isExplicitlyRelative(target: string): boolean {
  return target.startsWith('./') || target.startsWith('../');
}

/** Checks the effective compiler options (after `extends`) and returns one message per problem. */
export function checkCompilerOptions(projectDir: string, config: BucketsConfig, options: TS.CompilerOptions, configDir = projectDir): string[] {
  const problems: string[] = [];
  const key = aliasKey(config);
  const targets = options.paths?.[key];
  // `pathsBasePath` is internal: the folder of the tsconfig that declared `paths`, used when `baseUrl` is not set.
  const pathsBase = options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? configDir;
  const wanted = path.resolve(projectDir, config.root, '*');
  if (targets === undefined) {
    problems.push(`compilerOptions.paths has no "${key}" entry; it must be ["${expectedAliasTarget(projectDir, config, options.baseUrl, configDir)}"]`);
  } else if (
    targets.length !== 1 ||
    path.resolve(pathsBase, targets[0]!) !== wanted ||
    (options.baseUrl === undefined && !isExplicitlyRelative(targets[0]!))
  ) {
    problems.push(
      `compilerOptions.paths["${key}"] is ${JSON.stringify(targets)}; it must be ["${expectedAliasTarget(projectDir, config, options.baseUrl, configDir)}"]`,
    );
  }
  if (options.noUnusedLocals !== true) {
    problems.push('compilerOptions.noUnusedLocals must be true, so that an unused import breaks the build');
  }
  return problems;
}

/**
 * Checks which folders the build of the chosen config reaches: the root folder must be in it, inside `rootDir` when
 * that is set, and every nested project (folders relative to the project) must be out of it, because a nested project
 * builds with its own tsconfig.json. Returns one message per problem, each saying how to fix the config.
 */
export function checkBuildFolders(projectDir: string, config: BucketsConfig, projectConfig: ProjectConfig, nestedProjects: readonly string[] = []): string[] {
  const coverage = projectConfig.coverage;
  if (coverage === undefined) return [];
  const problems: string[] = [];
  const name = projectConfig.name;
  const configDir = path.dirname(projectConfig.file);
  const shown = (absolute: string): string => {
    const relative = toPosix(path.relative(configDir, absolute));
    return relative === '' ? '.' : relative;
  };
  const rootDir = path.resolve(projectDir, config.root);
  const root = `${toPosix(config.root)}/`;

  const reach = folderReach(coverage, rootDir);
  if (reach === 'none') {
    problems.push(
      `The effective "include" and "files" of ${name} (after "extends") do not reach ${root}, so the TypeScript build leaves the bucket code out. Add "${shown(rootDir)}" to "include" in ${name}`,
    );
  } else if (reach === 'excluded') {
    problems.push(
      `The effective "exclude" of ${name} (after "extends") leaves ${root} out, so the TypeScript build skips the bucket code. Remove the entry that matches ${root} from "exclude" in ${name}`,
    );
  }

  const declaredRootDir = projectConfig.options.rootDir;
  if (declaredRootDir !== undefined) {
    const inside = path.relative(path.resolve(projectDir, declaredRootDir), rootDir);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      problems.push(
        `compilerOptions.rootDir is "${shown(path.resolve(projectDir, declaredRootDir))}", which does not contain ${root}, so TypeScript rejects the bucket files (error TS6059). Set "rootDir" in ${name} to a folder that contains ${root}, such as ".", or remove it`,
      );
    }
  }

  for (const nested of nestedProjects) {
    const dir = path.resolve(projectDir, nested);
    const nestedReach = folderReach(coverage, dir);
    if (nestedReach === 'include') {
      problems.push(
        `The effective "include" of ${name} reaches the nested project ${nested}, so the TypeScript build of this project also compiles the files of that project, with the settings and alias of this one. Add "${shown(dir)}" to "exclude" in ${name}`,
      );
    } else if (nestedReach === 'files') {
      problems.push(
        `The "files" of ${name} list files of the nested project ${nested}, which builds with its own tsconfig.json. Remove them from "files" in ${name}`,
      );
    }
  }
  return problems;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

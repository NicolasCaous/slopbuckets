import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type ResolvedConfig } from './config.js';
import { CONFIG_FILE } from './paths.js';
import type { Violation } from './types.js';

/** Walks up from `start` to the first folder that holds buckets.config.json. */
export function findProjectDir(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A project that contains another folder. `config` is null when its buckets.config.json is invalid. */
export interface EnclosingProject {
  dir: string;
  config: ResolvedConfig | null;
}

/** Every project above `dir`, nearest first. */
export function enclosingProjects(dir: string): EnclosingProject[] {
  const out: EnclosingProject[] = [];
  let current = findProjectDir(path.dirname(path.resolve(dir)));
  while (current !== null) {
    const config = loadConfig(current);
    out.push({ dir: current, config: config.kind === 'ok' ? config.config : null });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = findProjectDir(parent);
  }
  return out;
}

/**
 * config-invalid when the project at `projectDir` uses the alias of a project that encloses it. `buckets init` refuses
 * such an alias for a new config; this catches a config written by hand or copied from the enclosing project.
 */
export function aliasReuseViolations(projectDir: string, config: ResolvedConfig): Violation[] {
  const owner = enclosingProjects(projectDir).find((p) => p.config?.alias === config.alias);
  if (owner === undefined) return [];
  return [
    {
      rule: 'config-invalid',
      file: CONFIG_FILE,
      message: `The alias "${config.alias}" is also the alias of the enclosing project ${owner.dir}. A nested project needs its own alias, or its imports would resolve into the wrong project. Choose another alias, such as "@${path.basename(config.root) || 'root'}-" followed by 8 letters or digits, set it as "alias" in ${CONFIG_FILE}, run \`buckets init\` in this project to add it to tsconfig.json, and change the imports that use "${config.alias}/".`,
    },
  ];
}

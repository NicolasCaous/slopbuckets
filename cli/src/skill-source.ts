import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This module sits one level below the package folder both as source (cli/src/) and bundled (cli/dist/).
// The published package ships the skill in <package>/skill/, copied there by cli/scripts/prepack.mjs. A repository
// checkout keeps the real skill in skill/ at the root; its cli/skill/ is a gitignored copy from the last pack, often
// stale, so a checkout prefers the root copy.

/** Absolute path of the skill file to install, or null when it cannot be found. `moduleUrl` is for tests. */
export function findSkillSource(moduleUrl: string = import.meta.url): string | null {
  const packageDir = fileURLToPath(new URL('..', moduleUrl));
  const repoDir = path.dirname(path.resolve(packageDir));
  const repoSkill = path.join(repoDir, 'skill', 'SKILL.md');
  // A checkout: the package folder is cli/ inside a folder that has skill/SKILL.md and a package.json.
  const checkout = path.basename(path.resolve(packageDir)) === 'cli' && existsSync(path.join(repoDir, 'package.json'));
  if (checkout && existsSync(repoSkill)) return repoSkill;
  const packaged = path.join(packageDir, 'skill', 'SKILL.md');
  return existsSync(packaged) ? packaged : null;
}

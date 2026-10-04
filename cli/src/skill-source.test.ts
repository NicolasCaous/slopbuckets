// findSkillSource in a repository checkout and in the published package layout.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findSkillSource } from './skill-source.js';
import { cleanupProjects, makeProject } from './testing/fixture.js';

afterEach(cleanupProjects);

const moduleIn = (dir: string, ...parts: string[]) => pathToFileURL(path.join(dir, ...parts)).href;

describe('findSkillSource', () => {
  it('prefers the root skill/ of a checkout over the stale cli/skill/ copy, from source and from dist', () => {
    const repo = makeProject({ 'package.json': '{"name":"slopbuckets-monorepo"}', 'skill/SKILL.md': 'fresh', 'cli/skill/SKILL.md': 'stale', 'cli/package.json': '{}' }, false);
    expect(findSkillSource(moduleIn(repo, 'cli', 'dist', 'index.js'))).toBe(path.join(repo, 'skill', 'SKILL.md'));
    expect(findSkillSource(moduleIn(repo, 'cli', 'src', 'skill-source.ts'))).toBe(path.join(repo, 'skill', 'SKILL.md'));
  });

  it('uses cli/skill/ in a checkout without the root copy', () => {
    const repo = makeProject({ 'package.json': '{}', 'cli/skill/SKILL.md': 'packed' }, false);
    expect(findSkillSource(moduleIn(repo, 'cli', 'dist', 'index.js'))).toBe(path.join(repo, 'cli', 'skill', 'SKILL.md'));
  });

  it('uses the skill/ of the installed package, even next to an unrelated package named skill or cli', () => {
    const root = makeProject({ 'node_modules/slopbuckets/skill/SKILL.md': 'packaged', 'node_modules/skill/SKILL.md': 'other', 'node_modules/package.json': '{}', 'node_modules/cli/package.json': '{}' }, false);
    expect(findSkillSource(moduleIn(root, 'node_modules', 'slopbuckets', 'dist', 'index.js'))).toBe(path.join(root, 'node_modules', 'slopbuckets', 'skill', 'SKILL.md'));
  });

  it('returns null when no copy exists', () => {
    const root = makeProject({ 'node_modules/slopbuckets/package.json': '{}' }, false);
    expect(findSkillSource(moduleIn(root, 'node_modules', 'slopbuckets', 'dist', 'index.js'))).toBeNull();
  });

  it('finds the root skill of this repository when run from source', () => {
    expect(findSkillSource()).toBe(fileURLToPath(new URL('../../skill/SKILL.md', import.meta.url)));
  });
});

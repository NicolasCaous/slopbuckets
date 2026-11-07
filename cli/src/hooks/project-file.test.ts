// Install writes never go through a link: the file, or a folder above it inside the project, that is a symbolic link
// or a junction, even a dangling one.
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { claudeAdapter } from './adapters/claude.js';
import { installInstructions } from './instructions.js';
import { writeProjectFile } from './project-file.js';

afterEach(cleanupProjects);

/** A file symlink needs a privilege on Windows; null when this machine cannot make one. */
function fileLink(target: string, link: string): string | null {
  try {
    symlinkSync(target, link, 'file');
    return link;
  } catch {
    return null;
  }
}

describe('writeProjectFile', () => {
  it('writes a new file and its folders', () => {
    const dir = makeProject({}, false);
    writeProjectFile(dir, 'a/b/c.txt', 'x');
    expect(existsSync(path.join(dir, 'a/b/c.txt'))).toBe(true);
  });

  it('refuses a folder that is a junction or a link, also when it points nowhere', () => {
    const dir = makeProject({}, false);
    const outside = makeProject({}, false);
    symlinkSync(outside, path.join(dir, '.claude'), 'junction');
    expect(() => writeProjectFile(dir, '.claude/settings.json', '{}')).toThrow(/does not write through links/);
    symlinkSync(path.join(outside, 'gone'), path.join(dir, '.codex'), 'junction');
    expect(() => writeProjectFile(dir, '.codex/hooks.json', '{}')).toThrow(/does not write through links/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a file that is a dangling symbolic link', () => {
    const dir = makeProject({}, false);
    const outside = makeProject({}, false);
    if (fileLink(path.join(outside, 'created.md'), path.join(dir, 'AGENTS.md')) === null) return;
    expect(() => writeProjectFile(dir, 'AGENTS.md', 'x')).toThrow(/does not write through links/);
    expect(existsSync(path.join(outside, 'created.md'))).toBe(false);
  });
});

describe('install through a link', () => {
  it('fails the step and writes nothing where the link points', () => {
    const dir = makeProject({}, false);
    const outside = makeProject({}, false);
    symlinkSync(outside, path.join(dir, '.claude'), 'junction');
    mkdirSync(path.join(outside, 'x'));
    const steps = claudeAdapter.install(dir, { skill: 'skill text' });
    expect(steps.map((s) => s.status)).toEqual(['failed', 'failed']);
    expect(steps[0]!.text).toContain('does not write through links');
    expect(readdirSync(outside)).toEqual(['x']);
    symlinkSync(outside, path.join(dir, '.agents'), 'junction');
    expect(installInstructions(dir, 'skill text').at(-1)).toMatchObject({ status: 'failed' });
    expect(readdirSync(outside)).toEqual(['x']);
  });
});

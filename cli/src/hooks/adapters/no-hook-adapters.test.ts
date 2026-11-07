// The adapters of harnesses without hooks: Zed and Continue (instructions only) and Aider (`read:` in .aider.conf.yml).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommand } from '../../commands/hook.js';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { fakeIo, testContext } from '../../testing/harness.js';
import { addAgentsRead, AIDER_CONFIG, aiderAdapter } from './aider.js';
import { continueAdapter } from './continue.js';
import { zedAdapter } from './zed.js';

afterEach(cleanupProjects);

describe('harnesses without hooks', () => {
  it('have no events, and buckets hook says so', async () => {
    for (const adapter of [zedAdapter, aiderAdapter, continueAdapter]) {
      expect(adapter.events).toEqual([]);
      const io = fakeIo({ cwd: makeProject({}, false), stdin: '{}' });
      expect(await hookCommand(testContext(), io, ['--agent', adapter.name, 'pre-tool-use'])).toBe(1);
      expect(io.err).toContain(`${adapter.title} has no hooks`);
    }
  });

  it('Continue and Zed write nothing and say that the agent relies on buckets check and the git hook', () => {
    const dir = makeProject({}, false);
    for (const adapter of [continueAdapter, zedAdapter]) {
      const steps = adapter.install(dir, { skill: null });
      expect(steps).toEqual([expect.objectContaining({ status: 'todo' })]);
      expect(steps[0]!.text).toContain('AGENTS.md');
      expect(steps[0]!.text).toContain('`buckets check` before it finishes');
      expect(steps[0]!.text).toContain('buckets init --git-hook');
    }
    expect(existsSync(path.join(dir, '.zed'))).toBe(false);
    expect(existsSync(path.join(dir, '.continue'))).toBe(false);
  });
});

describe('aider read merge', () => {
  it('adds AGENTS.md to every shape of read', () => {
    expect(addAgentsRead('')).toEqual({ kind: 'added', text: 'read: AGENTS.md  # slopbuckets\n' });
    expect(addAgentsRead('model: sonnet\n')).toEqual({ kind: 'added', text: 'model: sonnet\nread: AGENTS.md  # slopbuckets\n' });
    expect(addAgentsRead('read: CONVENTIONS.md\nmodel: sonnet\n')).toEqual({ kind: 'added', text: 'read:\n  - CONVENTIONS.md\n  - AGENTS.md  # slopbuckets\nmodel: sonnet\n' });
    expect(addAgentsRead('read:\n    - a.md\n    - "b.md"\n\nauto-commits: false\n')).toEqual({
      kind: 'added',
      text: 'read:\n    - a.md\n    - "b.md"\n    - AGENTS.md  # slopbuckets\n\nauto-commits: false\n',
    });
    expect(addAgentsRead('read: [a.md, b.md]\r\n')).toEqual({ kind: 'added', text: 'read:\r\n  - a.md\r\n  - b.md\r\n  - AGENTS.md  # slopbuckets\r\n' });
    expect(addAgentsRead('read:\n- a.md\n')).toEqual({ kind: 'added', text: 'read:\n- a.md\n- AGENTS.md  # slopbuckets\n' });
  });

  it('sees AGENTS.md that is already there, and refuses shapes it cannot edit', () => {
    for (const text of ['read: AGENTS.md\n', "read: 'AGENTS.md' # rules\n", 'read:\n  - x\n  - AGENTS.md\n', 'read: [x, AGENTS.md]\n']) expect(addAgentsRead(text).kind).toBe('present');
    expect(addAgentsRead('read: ["a, b.md"]\n').kind).toBe('unsupported');
    expect(addAgentsRead('read: a\nread: b\n').kind).toBe('unsupported');
  });
});

describe('aider install', () => {
  const read = (dir: string) => readFileSync(path.join(dir, AIDER_CONFIG), 'utf8');

  it('creates the config, runs a second time without changes, suggests test-cmd and the git hook', () => {
    const dir = makeProject({}, false);
    const steps = aiderAdapter.install(dir, { skill: null });
    expect(steps[0]).toEqual({ status: 'done', text: `Created ${AIDER_CONFIG} with "read: AGENTS.md"` });
    expect(steps[1]).toMatchObject({ status: 'todo', text: expect.stringContaining('`test-cmd: buckets check` and `auto-test: true`') });
    expect(steps[1]!.text).not.toContain('--file');
    expect(steps[1]!.text).not.toContain('lint-cmd');
    expect(steps[1]!.text).toContain('git-commit-verify: true');
    expect(steps[1]!.text).toContain('buckets init --git-hook');
    expect(aiderAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'kept', text: `${AIDER_CONFIG} already loads AGENTS.md` });
  });

  it("merges into the user's config", () => {
    const user = '# my aider settings\nmodel: sonnet\nread: CONVENTIONS.md\nauto-commits: false\n';
    const dir = makeProject({ [AIDER_CONFIG]: user }, false);
    expect(aiderAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    expect(read(dir)).toBe('# my aider settings\nmodel: sonnet\nread:\n  - CONVENTIONS.md\n  - AGENTS.md  # slopbuckets\nauto-commits: false\n');
    expect(aiderAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });
});

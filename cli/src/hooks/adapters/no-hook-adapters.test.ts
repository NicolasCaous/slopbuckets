// The adapters of harnesses without hooks: Zed (static tool permissions in user settings), Aider (`read:` in
// .aider.conf.yml) and Continue (instructions only).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommand } from '../../commands/hook.js';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { fakeIo, testContext } from '../../testing/harness.js';
import { addAgentsRead, AIDER_CONFIG, aiderAdapter, removeAgentsRead } from './aider.js';
import { continueAdapter } from './continue.js';
import { ZED_GUARDED_PATTERN, ZED_REFRESH_PATTERN, ZED_TOOL_PERMISSIONS, zedAdapter } from './zed.js';

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

  it('Continue and Zed write nothing and say what to do instead', () => {
    const dir = makeProject({}, false);
    expect(continueAdapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'todo', text: expect.stringContaining('--git-hook') })]);
    expect(zedAdapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'todo', text: expect.stringContaining('user settings') })]);
    expect(existsSync(path.join(dir, '.zed'))).toBe(false);
    expect(zedAdapter.uninstall(dir)).toEqual([]);
  });
});

describe('zed tool permissions', () => {
  // Zed matches case-insensitively by default. These patterns use no syntax that Rust's regex crate lacks.
  const refresh = new RegExp(ZED_REFRESH_PATTERN, 'i');
  const guarded = new RegExp(ZED_GUARDED_PATTERN, 'i');

  it('denies plain buckets refresh and lets buckets refresh --web through', () => {
    for (const command of ['buckets refresh', 'npx slopbuckets refresh', 'buckets refresh --web --yes', 'buckets.cmd refresh', 'buckets --verbose refresh', 'buckets refresh --webx']) {
      expect(refresh.test(command), command).toBe(true);
    }
    for (const command of ['buckets refresh --web', 'buckets refresh --web > refresh.log 2>&1', 'buckets check', 'buckets refresh --web &']) expect(refresh.test(command), command).toBe(false);
  });

  it('denies the lock and the config by name and by 8.3 short name', () => {
    for (const target of ['buckets.lock.json', 'C:\\shop\\BUCKETS.LOCK.JSON', 'cat BUCKET~1.JSO', 'buckets.config.json', 'root/log/_/engine/Buckets.Config.json']) {
      expect(guarded.test(target), target).toBe(true);
    }
    for (const target of ['package.json', 'root/_/buckets.ts', 'buckets.links.json']) expect(guarded.test(target), target).toBe(false);
  });

  it('has no look-around, which Rust regex rejects', () => {
    expect(JSON.stringify(ZED_TOOL_PERMISSIONS)).not.toMatch(/\(\?<?[=!]/);
  });

  it('matches the snippet on the Zed page of the docs', () => {
    const page = readFileSync(new URL('../../../../docs/guide/agents/zed.md', import.meta.url), 'utf8');
    const snippet = /```json\r?\n([\s\S]*?)```/.exec(page)?.[1];
    expect(JSON.parse(snippet ?? 'null')).toEqual(ZED_TOOL_PERMISSIONS);
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

  it('removes only the lines it added', () => {
    expect(removeAgentsRead('read:\n  - CONVENTIONS.md\n  - AGENTS.md  # slopbuckets\nmodel: sonnet\n')).toBe('read:\n  - CONVENTIONS.md\nmodel: sonnet\n');
    expect(removeAgentsRead('read: AGENTS.md\n')).toBe('read: AGENTS.md\n');
  });
});

describe('aider install', () => {
  const read = (dir: string) => readFileSync(path.join(dir, AIDER_CONFIG), 'utf8');

  it('creates the config, runs a second time without changes, suggests lint-cmd and the git hook, and uninstalls', () => {
    const dir = makeProject({}, false);
    const steps = aiderAdapter.install(dir, { skill: null });
    expect(steps[0]).toEqual({ status: 'done', text: `Created ${AIDER_CONFIG} with "read: AGENTS.md"` });
    expect(steps[1]).toMatchObject({ status: 'todo', text: expect.stringContaining('lint-cmd: "buckets check --file"') });
    expect(steps[1]!.text).toContain('git-commit-verify: true');
    expect(steps[1]!.text).toContain('buckets init --git-hook');
    expect(aiderAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'kept', text: `${AIDER_CONFIG} already loads AGENTS.md` });
    expect(aiderAdapter.uninstall(dir)).toEqual([{ status: 'done', text: `Removed ${AIDER_CONFIG}, which held only the slopbuckets line` }]);
    expect(existsSync(path.join(dir, AIDER_CONFIG))).toBe(false);
    expect(aiderAdapter.uninstall(dir)).toEqual([]);
  });

  it("merges into the user's config and gives it back on uninstall", () => {
    const user = '# my aider settings\nmodel: sonnet\nread: CONVENTIONS.md\nauto-commits: false\n';
    const dir = makeProject({ [AIDER_CONFIG]: user }, false);
    expect(aiderAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    expect(read(dir)).toBe('# my aider settings\nmodel: sonnet\nread:\n  - CONVENTIONS.md\n  - AGENTS.md  # slopbuckets\nauto-commits: false\n');
    expect(aiderAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
    expect(aiderAdapter.uninstall(dir)[0]).toMatchObject({ status: 'done' });
    expect(read(dir)).toBe('# my aider settings\nmodel: sonnet\nread:\n  - CONVENTIONS.md\nauto-commits: false\n');
  });
});

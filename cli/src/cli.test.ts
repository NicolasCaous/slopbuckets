import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { helpText, main } from './cli.js';
import type { SnapshotV2 } from './contract/snapshot.js';
import { createFakeEngine } from './testing/fake-engine.js';
import { fakeUpdates } from './testing/fake-updates.js';
import { cleanupProjects, makeProject } from './testing/fixture.js';
import { fakeIo, testContext } from './testing/harness.js';

afterEach(cleanupProjects);

const SNAPSHOT = JSON.parse(readFileSync(new URL('../../examples/fixtures/snapshots/small.json', import.meta.url), 'utf8')) as SnapshotV2;

describe('buckets command line', () => {
  it('prints help and versions', async () => {
    const io = fakeIo({ cwd: '.' });
    expect(await main(testContext(), io, ['--help'])).toBe(0);
    expect(io.out).toContain('Usage: buckets');
    const version = fakeIo({ cwd: '.' });
    expect(await main(testContext(), version, ['--version'])).toBe(0);
    expect(version.out).toBe('buckets 1.0.0\nadapter ts 2.0.0 (protocol 2)\n');
  });

  it('lists only the 2.0 commands and exit codes in the help', () => {
    const help = helpText('1.0.0');
    for (const gone of ['refresh', 'link', 'lock', 'DMZ', '--file']) expect(help).not.toContain(gone);
    for (const kept of ['init', 'check', 'inspect', 'hook', 'update']) expect(help).toContain(`  ${kept}`);
    expect(help).not.toMatch(/^ {2}2 {2}/m);
    const flat = help.replace(/\s+/g, ' ');
    expect(flat).toContain('writes an empty buckets.config.json, adds .buckets/ to .gitignore');
    for (const format of ['(svg)', '(mermaid)', '(dot)', '(html)']) expect(flat).toContain(format);
    // fix --bucket picks the imported bucket, not the importing one.
    expect(flat).toContain('--bucket <name> fixes only the imports into that bucket');
  });

  it('rejects unknown commands, including the removed ones', async () => {
    for (const command of ['nope', 'refresh', 'link']) {
      const io = fakeIo({ cwd: '.' });
      expect(await main(testContext(), io, [command])).toBe(64);
      expect(io.err).toContain('unknown command');
    }
    const option = fakeIo({ cwd: '.' });
    expect(await main(testContext(), option, ['--jsno'])).toBe(64);
    expect(option.err).toContain('unknown option "--jsno"');
    expect(await main(testContext(), fakeIo({ cwd: '.' }), ['hook'])).toBe(64);
  });

  it('knows the 2.0 commands in the help and in the typo suggestions', async () => {
    const help = helpText('1.0.0');
    const typos = { uninstal: 'uninstall', fixx: 'fix', fnt: 'fmt', shwo: 'show', 'merge-drive': 'merge-driver', docter: 'doctor' };
    for (const [typo, command] of Object.entries(typos)) {
      expect(help).toMatch(new RegExp(`^ {2}${command}\\b`, 'm'));
      const io = fakeIo({ cwd: '.' });
      expect(await main(testContext(), io, [typo])).toBe(64);
      expect(io.err).toContain(`Did you mean \`buckets ${command}\`?`);
    }
  });

  it('never checks for updates in merge-driver, which git runs', async () => {
    const dir = makeProject({});
    for (const [args, checks] of [
      [['merge-driver'], 0],
      [['fmt', '--help'], 1],
    ] as const) {
      const io = fakeIo({ cwd: dir, env: {} });
      const updates = fakeUpdates({ cacheDir: null });
      io.updates = updates;
      await main(testContext(), io, [...args]);
      expect(updates.requests.length, args.join(' ')).toBe(checks);
    }
  });

  it('runs check and inspect through the engine', async () => {
    const engine = createFakeEngine({ snapshot: SNAPSHOT });
    const ctx = { ...testContext(), engine };
    const dir = makeProject({});
    const checked = fakeIo({ cwd: dir });
    expect(await main(ctx, checked, ['check', '--json', '--no-recursive'])).toBe(0);
    expect(JSON.parse(checked.out)).toEqual({ exitCode: 0, violations: [], environment: [], advice: [], projects: ['.'] });
    expect(engine.calls[0]).toMatchObject({ method: 'checkAll', recursive: false });
    const inspected = fakeIo({ cwd: dir });
    expect(await main(ctx, inspected, ['inspect', '--json'])).toBe(0);
    expect(JSON.parse(inspected.out)).toMatchObject({ snapshotVersion: 2 });
  });
});

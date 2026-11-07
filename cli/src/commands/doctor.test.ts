import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import type { EnvironmentError } from '../contract/engine.js';
import type { FileGroup, FileOwner, SnapshotProject, SnapshotV2 } from '../contract/snapshot.js';
import { findAgentBuckets } from './doctor.js';
import { gitHookBlock } from '../hooks/git-hook.js';
import { createFakeEngine, type FakeEngineScript } from '../testing/fake-engine.js';
import { fakeUpdates } from '../testing/fake-updates.js';
import { cleanupProjects, makeProject, writeFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { SAMPLES } from '../testing/samples.js';

afterEach(cleanupProjects);

const CONFIG = JSON.stringify({ version: '2.0', projects: ['packages/sdk'], buckets: {} });
const SKILL = '---\nname: slopbuckets\nmetadata:\n  slopbuckets-version: "2.0.0"\n---\n';
const LOCAL = 'node ./node_modules/slopbuckets/dist/index.js';

function project(at: string, files: FileGroup[], environment: EnvironmentError | null = null): SnapshotProject {
  return { path: at, environment, ignore: [], projects: [], buckets: [], edges: [], files, violations: [], advice: [] };
}

const snapshotOf = (...projects: SnapshotProject[]): SnapshotV2 => ({ snapshotVersion: 2, projects });

/** A fake engine whose snapshot shows a root project without source files, unless the script gives another. */
const fakeEngine = (script: FakeEngineScript = {}) => createFakeEngine({ snapshot: snapshotOf(project('.', [])), ...script });

function repo(files: Record<string, string>): string {
  const dir = makeProject(files, false);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function doctor(dir: string, engine = fakeEngine(), env: Record<string, string> = { PATH: '' }) {
  const io = fakeIo({ cwd: path.join(dir, 'src'), env });
  io.updates = fakeUpdates({ packageDir: path.join(dir, 'node_modules', 'slopbuckets'), platform: process.platform });
  const code = await main({ ...testContext(), cliVersion: '2.0.0', engine }, io, ['doctor']);
  return { code, out: io.out, err: io.err };
}

describe('buckets doctor', () => {
  it('exits with 0 when every check passes, and says what it found', async () => {
    const dir = repo({
      'buckets.config.json': CONFIG,
      'tsconfig.json': '{}',
      'packages/sdk/tsconfig.json': '{}',
      'package.json': '{ "devDependencies": { "slopbuckets": "2.0.0" } }',
      'node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "2.0.0" }',
      'node_modules/slopbuckets/dist/index.js': '',
      'node_modules/typescript/package.json': '{ "name": "typescript", "version": "5.9.3" }',
      '.claude/skills/slopbuckets/SKILL.md': SKILL,
      '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `${LOCAL} hook stop` }] }] } }),
      '.git/hooks/pre-commit': `#!/bin/sh\n${gitHookBlock('')}\n`,
    });
    const result = await doctor(dir);
    expect(result.out).toContain(`buckets doctor in ${dir}`);
    for (const line of [
      '`buckets` is not on PATH. This project has its own slopbuckets 2.0.0',
      'buckets.config.json has version "2.0", which slopbuckets 2.0.0 reads.',
      '+ tsconfig.json exists.',
      '+ packages/sdk/tsconfig.json exists.',
      "slopbuckets resolves imports with the project's TypeScript 5.9.3.",
      'Every relative, paths and workspace import resolves.',
      'The skill in .claude/skills/slopbuckets/SKILL.md is the one of slopbuckets 2.0.0.',
      `The agent hooks in .claude/settings.json run \`${LOCAL}\`, which is slopbuckets 2.0.0.`,
      'The git pre-commit hook in .git/hooks/pre-commit runs `node ./node_modules/slopbuckets/dist/index.js`.',
    ]) {
      expect(result.out).toContain(line);
    }
    expect(result.out).toContain('\nEvery check passes.\n');
    expect(result.code).toBe(0);
  });

  it('exits with 1 and gives the fix of each problem', async () => {
    const dir = repo({
      'buckets.config.json': JSON.stringify({ version: '2.3', projects: ['packages/sdk'], buckets: {} }),
      '.agents/skills/slopbuckets/SKILL.md': SKILL.replace('2.0.0', '0.9.0'),
      '.codex/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'buckets hook --agent codex stop' }] }] } }),
      'node_modules/typescript/package.json': '{ "name": "typescript", "version": "7.0.0" }',
      '.git/hooks/pre-commit': '#!/bin/sh\n# slopbuckets:start\nif command -v buckets >/dev/null 2>&1; then\n  buckets check\nfi\n# slopbuckets:end\n',
    });
    const unresolved = [SAMPLES['import-unresolved'], { ...SAMPLES['import-unresolved'], kind: 'workspace' as const, line: 9 }];
    const environment = [{ code: 'config-newer' as const, project: '.', message: 'Run buckets update.' }];
    const result = await doctor(dir, fakeEngine({ violations: unresolved, environment, snapshot: snapshotOf(project('.', [], environment[0]!)) }));
    for (const line of [
      '`buckets` is not on PATH, and the project has no slopbuckets in node_modules.',
      'buckets.config.json has version "2.3", which needs slopbuckets 2.3 or later, and this is slopbuckets 2.0.0. Run buckets update',
      'tsconfig.json is missing. Every project with code needs one in its own folder.',
      'packages/sdk/tsconfig.json is missing.',
      'The project has TypeScript 7.0.0, which slopbuckets cannot use because TypeScript 7 has no JavaScript API',
      'cannot check (config-newer): Run buckets update.',
      '2 imports do not resolve (1 workspace, 1 relative).',
      'The skill in .agents/skills/slopbuckets/SKILL.md is from slopbuckets 0.9.0, not 2.0.0. Run `buckets init`',
      'The agent hooks in .codex/hooks.json run `buckets`, which is not installed, so they fail without a word.',
      'The git pre-commit hook in .git/hooks/pre-commit finds no slopbuckets, so it skips the check.',
    ]) {
      expect(result.out).toContain(line);
    }
    expect(result.out).toMatch(/\n\d+ problems\. Fix them and run `buckets doctor` again\.\n$/);
    expect(result.code).toBe(1);
  });

  it('flags a global buckets that differs from the version the project pins', async () => {
    const dir = repo({
      'buckets.config.json': CONFIG,
      'node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "2.0.0" }',
      'global/node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "0.9.0" }',
      'global/node_modules/slopbuckets/dist/index.js': '',
    });
    // A POSIX bin link is a symlink; a copy of the script in the package folder is followed the same way by binTarget.
    const bin = path.join(dir, 'global', 'node_modules', 'slopbuckets', 'dist');
    const name = process.platform === 'win32' ? 'buckets.cmd' : 'buckets';
    writeFile(dir, `global/node_modules/slopbuckets/dist/${name}`, process.platform === 'win32' ? '@"%~dp0\\index.js" %*\r\n' : '#!/bin/sh\n');
    spawnSync('chmod', ['+x', path.join(bin, name)]);
    const result = await doctor(dir, fakeEngine(), { PATH: bin, PATHEXT: '.CMD' });
    expect(result.out).toContain('The global `buckets` is slopbuckets 0.9.0, and the project pins 2.0.0. Run `npm install -g slopbuckets@2.0.0`');
    expect(result.code).toBe(1);
  });

  /** A project whose hooks run a global `buckets` of `version`, with the skill of 2.0.0 and no copy of its own. */
  function globalHooks(version: string): { dir: string; bin: string } {
    const dir = repo({
      'buckets.config.json': CONFIG,
      '.claude/skills/slopbuckets/SKILL.md': SKILL,
      '.agents/skills/slopbuckets/SKILL.md': SKILL,
      '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'buckets hook stop' }] }] } }),
      'global/node_modules/slopbuckets/package.json': `{ "name": "slopbuckets", "version": "${version}" }`,
      'global/node_modules/slopbuckets/dist/index.js': '',
    });
    const bin = path.join(dir, 'global', 'node_modules', 'slopbuckets', 'dist');
    const name = process.platform === 'win32' ? 'buckets.cmd' : 'buckets';
    writeFile(dir, `global/node_modules/slopbuckets/dist/${name}`, process.platform === 'win32' ? '@"%~dp0\\index.js" %*\r\n' : '#!/bin/sh\n');
    spawnSync('chmod', ['+x', path.join(bin, name)]);
    return { dir, bin };
  }

  it('flags hooks that run another version than this command and the skill', async () => {
    const { dir, bin } = globalHooks('2.1.0');
    const result = await doctor(dir, fakeEngine(), { PATH: bin, PATHEXT: '.CMD' });
    expect(result.out).toContain('The agent hooks in .claude/settings.json run `buckets`, which is slopbuckets 2.1.0 in ');
    expect(result.out).toContain(
      'but this command is slopbuckets 2.0.0, and the skill in .claude/skills/slopbuckets/SKILL.md and .agents/skills/slopbuckets/SKILL.md is from slopbuckets 2.0.0. Install the same version globally with `npm install -g slopbuckets@2.0.0`',
    );
    expect(result.code).toBe(1);
  });

  it('fails hooks that run a copy older than the config version', async () => {
    const { dir, bin } = globalHooks('1.2.1');
    const result = await doctor(dir, fakeEngine(), { PATH: bin, PATHEXT: '.CMD' });
    expect(result.out).toContain('The agent hooks in .claude/settings.json run `buckets`, which is slopbuckets 1.2.1 in ');
    expect(result.out).toContain('older than version "2.0" of buckets.config.json, so they cannot check the project.');
    expect(result.code).toBe(1);
  });

  it('does not count a buckets that only this process finds: the folder of its node, or a node_modules/.bin', async () => {
    const { dir, bin } = globalHooks('2.0.0');
    expect(findAgentBuckets({ PATH: bin, PATHEXT: '.CMD' }, process.platform)).not.toBeNull();
    expect(findAgentBuckets({ PATH: bin, PATHEXT: '.CMD' }, process.platform, path.join(bin, 'node.exe'))).toBeNull();
    const npx = path.join(dir, 'node_modules', '.bin');
    writeFile(dir, `node_modules/.bin/buckets${process.platform === 'win32' ? '.cmd' : ''}`, '#!/bin/sh\n');
    spawnSync('chmod', ['+x', path.join(npx, 'buckets')]);
    expect(findAgentBuckets({ PATH: npx, PATHEXT: '.CMD' }, process.platform)).toBeNull();
    const result = await doctor(dir, fakeEngine(), { PATH: npx, PATHEXT: '.CMD' });
    expect(result.out).toContain('The agent hooks in .claude/settings.json run `buckets`, which is not installed');
    expect(result.code).toBe(1);
  });

  it('asks for a tsconfig.json only in a project with a source file the check reads', async () => {
    const dir = repo({ 'buckets.config.json': CONFIG, 'packages/sdk/tsconfig.json': '{}' });
    const root = (owner: FileOwner) => snapshotOf(project('.', [{ dir: 'scripts', owner, names: ['build.ts'] }]));
    const ignored = await doctor(dir, fakeEngine({ snapshot: root({ state: 'ignored' }) }));
    expect(ignored.out).toContain('+ tsconfig.json does not exist. The project needs none, because each of its source files is ignored or belongs to a nested project.');
    expect(ignored.out).toContain('+ packages/sdk/tsconfig.json exists.');
    expect(ignored.out).not.toContain('tsconfig.json is missing');
    const owned = await doctor(dir, fakeEngine({ snapshot: root({ state: 'unowned' }) }));
    expect(owned.out).toContain('- tsconfig.json is missing. Every project with code needs one in its own folder.');
  });

  it('reads the hook commands only from the hook files of the agents, not from nested worktrees or other files', async () => {
    const settings = (command: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `${command} hook stop` }] }] } });
    const dir = repo({
      'buckets.config.json': CONFIG,
      'node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "2.0.0" }',
      'node_modules/slopbuckets/dist/index.js': '',
      '.claude/settings.json': settings(LOCAL),
      '.claude/commands/check.js': 'run("buckets hook stop")',
      '.claude/worktrees/agent-1/.git': 'gitdir: ../../../.git/worktrees/agent-1\n',
      '.claude/worktrees/agent-1/.claude/settings.json': settings('buckets'),
      '.claude/worktrees/agent-1/scripts/bench.mjs': 'spawn("buckets hook stop")',
      '.github/hooks/team.json': JSON.stringify({ hooks: { agentStop: [{ bash: `${LOCAL} hook --agent copilot agent-stop` }] } }),
    });
    const result = await doctor(dir);
    expect(result.out).toContain(`+ The agent hooks in .claude/settings.json, .github/hooks/team.json run \`${LOCAL}\`, which is slopbuckets 2.0.0.`);
    expect(result.out).not.toContain('worktrees');
    expect(result.out).not.toContain('check.js');
    expect(result.out).not.toContain('run `buckets`');
  });

  it('rejects options it does not know with 64', async () => {
    const io = fakeIo({ cwd: makeProject({}) });
    expect(await main(testContext(), io, ['doctor', '--fix'])).toBe(64);
    expect(io.err).toContain('unknown option "--fix". Usage: buckets doctor');
  });
});

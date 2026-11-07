// What `buckets init` derives from the install and the project: the command the hooks run, the version line of the
// skill, the warnings it cannot fix and the closing prompt.
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAdapter } from '../hooks/adapters/claude.js';
import { harnesses } from '../hooks/registry.js';
import { fakeUpdates } from '../testing/fake-updates.js';
import { cleanupProjects, fileExists, makeProject, readFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { AGENT_PROMPT, firstArchitecturePrompt, initCommand } from './init.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupProjects();
});

const SKILL = '---\nname: slopbuckets\ndescription: x\n---\n# skill\n';
const LOCAL = 'node ./node_modules/slopbuckets/dist/index.js';
/** The Claude Code hook command of a local install, as .claude/settings.json holds it, with its quotes escaped. */
const CLAUDE_LOCAL = JSON.stringify('node "$CLAUDE_PROJECT_DIR/node_modules/slopbuckets/dist/index.js"').slice(1, -1);

function project(files: Record<string, string> = {}): { dir: string; skill: string } {
  const dir = makeProject({ 'tsconfig.json': '{}', ...files }, false);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const skill = makeProject({ 'SKILL.md': SKILL }, false);
  return { dir, skill: path.join(skill, 'SKILL.md') };
}

async function init(dir: string, skill: string, options: { args?: string[]; packageDir?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const io = fakeIo({ cwd: options.cwd ?? dir, env: options.env ?? {} });
  if (options.packageDir !== undefined) io.updates = fakeUpdates({ packageDir: options.packageDir });
  const code = await initCommand(testContext(), io, options.args ?? [], { skillSource: skill });
  return { code, out: io.out, err: io.err };
}

const localFiles = {
  'package.json': '{ "devDependencies": { "slopbuckets": "1.0.0" } }',
  'node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "1.0.0" }',
  'node_modules/slopbuckets/dist/index.js': '',
};

const USER_FILES = new Set(['tsconfig.json', ...Object.keys(localFiles)]);

/** Every file below `dir`, relative and with forward slashes. */
function walk(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    return entry.isDirectory() ? walk(dir, child) : [child];
  });
}

describe('the command init writes into the hooks', () => {
  it('is the path of the project copy for a local install, and the git hook runs that copy', async () => {
    const { dir, skill } = project(localFiles);
    const install = vi.spyOn(claudeAdapter, 'install');
    const result = await init(dir, skill, { args: ['--git-hook'], packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    expect(result.code).toBe(0);
    expect(install).toHaveBeenCalledWith(dir, { skill: expect.stringContaining('slopbuckets-version: "1.0.0"'), command: LOCAL });
    expect(readFile(dir, '.git/hooks/pre-commit')).toContain("if [ -f 'node_modules/slopbuckets/dist/index.js' ]; then");
    expect(result.out).not.toContain('fail without a word');
  });

  it('is relative to the project when the copy sits in the node_modules of a workspace root', async () => {
    const { dir, skill } = project(localFiles);
    const app = path.join(dir, 'apps', 'web');
    const install = vi.spyOn(claudeAdapter, 'install');
    await init(dir, skill, { cwd: app, packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    expect(install).toHaveBeenCalledWith(app, expect.objectContaining({ command: 'node ../../node_modules/slopbuckets/dist/index.js' }));
  });

  it('is buckets for a global install, with a warning when buckets is not on PATH', async () => {
    const { dir, skill } = project();
    const global = makeProject({ 'lib/node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "1.0.0" }' }, false);
    const install = vi.spyOn(claudeAdapter, 'install');
    const result = await init(dir, skill, { packageDir: path.join(global, 'lib', 'node_modules', 'slopbuckets'), env: { PATH: '' } });
    expect(result.code).toBe(0);
    expect(install).toHaveBeenCalledWith(dir, expect.objectContaining({ command: 'buckets' }));
    expect(result.out).toContain('The hooks run `buckets`, which is not on PATH here, so they would fail without a word.');
  });

  it('stays the path of the project copy when a global copy runs init in a project with its own copy, and says so', async () => {
    const { dir, skill } = project(localFiles);
    const global = makeProject({ 'lib/node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "1.0.0" }' }, false);
    const first = await init(dir, skill, { packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    expect(first.out).not.toContain('not the copy that runs this init');
    const install = vi.spyOn(claudeAdapter, 'install');
    const again = await init(dir, skill, { packageDir: path.join(global, 'lib', 'node_modules', 'slopbuckets'), env: { PATH: '' } });
    expect(again.code).toBe(0);
    expect(install).toHaveBeenCalledWith(dir, expect.objectContaining({ command: LOCAL }));
    expect(readFile(dir, '.claude/settings.json')).toContain(`${CLAUDE_LOCAL} hook stop`);
    expect(again.out).toContain(`The hooks run the project's own slopbuckets 1.0.0 in node_modules (\`${LOCAL}\`), not the copy that runs this init`);
  });

  it('is the path of a copy run from inside the project outside node_modules, such as a checkout, and buckets for one outside', async () => {
    const { dir, skill } = project({ 'tools/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "1.0.0" }', 'tools/slopbuckets/dist/index.js': '' });
    const install = vi.spyOn(claudeAdapter, 'install');
    const inside = await init(dir, skill, { packageDir: path.join(dir, 'tools', 'slopbuckets') });
    expect(install).toHaveBeenLastCalledWith(dir, expect.objectContaining({ command: 'node ./tools/slopbuckets/dist/index.js' }));
    expect(inside.out).not.toContain('fail without a word');
    const outside = makeProject({ 'slopbuckets/package.json': '{ "name": "slopbuckets", "version": "1.0.0" }' }, false);
    await init(dir, skill, { packageDir: path.join(outside, 'slopbuckets'), env: { PATH: '' } });
    expect(install).toHaveBeenLastCalledWith(dir, expect.objectContaining({ command: 'buckets' }));
  });

  it('runs the project copy in the files of every agent, and never a bare buckets', async () => {
    const { dir, skill } = project(localFiles);
    const result = await init(dir, skill, { args: ['--agent', harnesses().map((h) => h.name).join(','), '--git-hook'], packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    expect(result.code).toBe(0);
    const written = walk(dir).filter((file) => !file.startsWith('node_modules/') && !file.startsWith('.git/') && !USER_FILES.has(file));
    const bare: string[] = [];
    const plugins: string[] = [];
    for (const file of written) {
      const lines = readFile(dir, file).split(/\r?\n/);
      // A code plugin names the command once, and its comments and messages say `buckets hook` as prose.
      const command = lines.find((line) => line.startsWith('const COMMAND = '));
      if (command !== undefined) {
        plugins.push(file);
        expect(command, file).toBe(`const COMMAND = ${JSON.stringify(LOCAL)};`);
        continue;
      }
      lines.forEach((line, i) => {
        if (/buckets(?:\.cmd)?["']?\s+(?:hook|merge-driver)\b/.test(line) && !line.includes(LOCAL) && !/PROJECT_DIR\/node_modules\/slopbuckets\/dist\/index\.js/.test(line)) bare.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bare).toEqual([]);
    expect(plugins.length).toBeGreaterThan(0);
    expect(readFile(dir, '.claude/settings.json')).toContain(`${CLAUDE_LOCAL} hook pre-tool-use`);
    expect(spawnSync('git', ['config', '--get', 'merge.slopbuckets.driver'], { cwd: dir, encoding: 'utf8' }).stdout.trim()).toBe(`${LOCAL} merge-driver %O %A %B`);
  });

  it('warns when the project copy it would run is missing', async () => {
    const { dir, skill } = project({ 'package.json': localFiles['package.json'], 'node_modules/slopbuckets/package.json': localFiles['node_modules/slopbuckets/package.json'] });
    const result = await init(dir, skill, { packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`The hooks run \`${LOCAL}\`, and that file does not exist`);
  });
});

describe('the skill copies', () => {
  it('carry the CLI version in their frontmatter', async () => {
    const { dir, skill } = project();
    await init(dir, skill);
    const stamped = '---\nname: slopbuckets\ndescription: x\nmetadata:\n  slopbuckets-version: "1.0.0"\n---\n# skill\n';
    expect(readFile(dir, '.claude/skills/slopbuckets/SKILL.md')).toBe(stamped);
    expect(readFile(dir, '.agents/skills/slopbuckets/SKILL.md')).toBe(stamped);
  });
});

describe('the warnings of init', () => {
  it('warns about a missing tsconfig.json and a TypeScript the project has but slopbuckets will not use, without failing', async () => {
    const { dir, skill } = project({ 'node_modules/typescript/package.json': '{ "name": "typescript", "version": "7.0.1" }' });
    const typescript = await init(dir, skill);
    expect(typescript.code).toBe(0);
    expect(typescript.out).toContain('The project has TypeScript 7.0.1, which slopbuckets cannot use because TypeScript 7 has no JavaScript API, so it resolves imports with its own TypeScript 6.');
    expect(typescript.out).not.toContain('There is no tsconfig.json');

    const old = project({ 'node_modules/typescript/package.json': '{ "name": "typescript", "version": "4.9.5" }' });
    expect((await init(old.dir, old.skill)).out).toContain('The project has TypeScript 4.9.5, which slopbuckets cannot use because slopbuckets needs TypeScript 5 or 6');
    const fine = project({ 'node_modules/typescript/package.json': '{ "name": "typescript", "version": "5.9.3" }' });
    expect((await init(fine.dir, fine.skill)).out).not.toContain('TypeScript');

    const bare = makeProject({}, false);
    spawnSync('git', ['init', '-q'], { cwd: bare });
    const noConfig = await init(bare, skill);
    expect(noConfig.code).toBe(0);
    expect(noConfig.out).toContain('There is no tsconfig.json here, and `buckets check` needs one.');
  });

  it('warns when the buckets on PATH that the hooks run is another version than this init', async () => {
    const { dir, skill } = project();
    const global = makeProject({ 'node_modules/slopbuckets/package.json': '{ "name": "slopbuckets", "version": "0.9.0" }', 'node_modules/slopbuckets/dist/index.js': '' }, false);
    const bin = path.join(global, 'node_modules', 'slopbuckets', 'dist');
    const name = process.platform === 'win32' ? 'buckets.cmd' : 'buckets';
    writeFileSync(path.join(bin, name), process.platform === 'win32' ? '@"%~dp0\\index.js" %*\r\n' : '#!/bin/sh\n');
    chmodSync(path.join(bin, name), 0o755);
    const io = fakeIo({ cwd: dir, env: { PATH: bin, PATHEXT: '.CMD' } });
    io.updates = fakeUpdates({ packageDir: path.join(global, 'node_modules', 'slopbuckets'), platform: process.platform });
    expect(await initCommand(testContext(), io, [], { skillSource: skill })).toBe(0);
    expect(io.out.replace(/\s+/g, ' ')).toContain('The hooks run `buckets`, which is slopbuckets 0.9.0 in');
    expect(io.out.replace(/\s+/g, ' ')).toContain('not this slopbuckets 1.0.0');
  });

  it('below the top of the repository, explains that a session at the top misses the hooks, and --root installs them there too', async () => {
    const { dir, skill } = project({ 'apps/web/tsconfig.json': '{}' });
    const app = path.join(dir, 'apps', 'web');
    const result = await init(dir, skill, { cwd: app });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`This folder is below the top of its git repository, ${dir}. An agent session opened at the top folder does not read the hooks of this folder`);
    expect(result.out).toContain('Run `buckets init --root`');
    expect(fileExists(dir, '.claude/settings.json')).toBe(false);

    const rooted = await init(dir, skill, { cwd: app, args: ['--root'] });
    expect(rooted.code).toBe(0);
    expect(fileExists(dir, '.claude/settings.json')).toBe(true);
    expect(fileExists(app, '.claude/settings.json')).toBe(true);
    expect(fileExists(dir, 'buckets.config.json')).toBe(false);
    expect(rooted.out).not.toContain('below the top');

    const top = await init(dir, skill);
    expect(top.out).not.toContain('below the top');
  });
});

describe('the end of init', () => {
  it('prints the prompt that builds the first architecture, with the check command of the install, and no install step', async () => {
    const { dir, skill } = project(localFiles);
    const result = await init(dir, skill, { packageDir: path.join(dir, 'node_modules', 'slopbuckets') });
    const prompt = firstArchitecturePrompt('npx buckets check');
    expect(result.out.endsWith(`\nPaste this prompt into your coding agent:\n\n  ${prompt}\n`)).toBe(true);
    expect(prompt).toBe(
      'slopbuckets is set up in this project. Build its first architecture as the section "The first architecture after buckets init" of .agents/skills/slopbuckets/SKILL.md says, and run `npx buckets check` until it exits with 0.',
    );
    expect(result.out).not.toContain(AGENT_PROMPT);
    // The install prompt stays in the docs, for a project without slopbuckets.
    const docs = readFileSync(new URL('../../../docs/guide/install-with-an-agent.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(docs).toContain(`\`\`\`text\n${AGENT_PROMPT}\n\`\`\``);
  });

  it('prints no prompt for a config that already has buckets', async () => {
    const { dir, skill } = project({ 'buckets.config.json': '{ "version": "2.0", "buckets": { "app": { "purpose": "Runs the app", "files": ["src/**"], "public": null } } }' });
    const result = await init(dir, skill);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Paste this prompt');
  });
});

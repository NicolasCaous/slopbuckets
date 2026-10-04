// Hooks, init and the terminal refresh with nested projects.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLock } from '../core/lock.js';
import { cleanupProjects, fileExists, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { hookCommand, touchesLock } from './hook.js';
import { enclosingProjects, initCommand } from './init.js';
import { refreshCommand } from './refresh.js';

afterEach(cleanupProjects);

const NESTED = 'root/billing/_/engine';
const NESTED_FILES: Record<string, string> = {
  [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
  [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
  [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
};

async function tree(): Promise<string> {
  const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_FILES });
  await approve(dir);
  await approve(path.join(dir, NESTED));
  return dir;
}

async function hook(event: string, input: unknown, dir: string) {
  const io = fakeIo({ cwd: dir, stdin: JSON.stringify(input), env: { CLAUDE_PROJECT_DIR: dir } });
  const code = await hookCommand(testContext(), io, [event]);
  return { code, out: io.out };
}

describe('hooks with nested projects', () => {
  it('pre-tool-use denies writes to a nested buckets.lock.json', () => {
    expect(touchesLock({ tool_name: 'Write', tool_input: { file_path: `/p/${NESTED}/buckets.lock.json` } })).toBe(true);
    expect(touchesLock({ tool_name: 'Bash', tool_input: { command: `cp x ${NESTED}/buckets.lock.json` } })).toBe(true);
    expect(touchesLock({ tool_name: 'Edit', tool_input: { file_path: '/p/buckets.links.json' } })).toBe(false);
    expect(touchesLock({ tool_name: 'Bash', tool_input: { command: 'buckets link add api ../api/root/dmz/server/.external.ts' } })).toBe(false);
  });

  it('post-tool-use checks the edited file in its nearest project', async () => {
    const dir = await tree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    const { code, out } = await hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, NESTED, 'root/_/run.ts') } }, dir);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('buckets check --file root/_/run.ts');
    expect(parsed.reason).toContain('import-relative');
    // The paths are relative to the nested project, so the message names it.
    expect(parsed.reason).toContain(`in the nested project ${NESTED}`);
  });

  it('post-tool-use ignores files of a nested project outside its root folder', async () => {
    const dir = await tree();
    const { out } = await hook('post-tool-use', { tool_name: 'Write', tool_input: { file_path: path.join(dir, NESTED, 'notes.md') } }, dir);
    expect(out).toBe('');
  });

  it('stop runs the recursive check and blocks on a nested failure', async () => {
    const dir = await tree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    const { out } = await hook('stop', {}, dir);
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain(`== Project ${NESTED}`);
  });

  it('stop passes when every project passes', async () => {
    const dir = await tree();
    expect((await hook('subagent-stop', {}, dir)).out).toBe('');
  });
});

describe('buckets init inside another project', () => {
  it('creates a nested project without hooks or skill, with a suggested alias', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const nested = path.join(dir, 'root/billing/_/engine');
    writeFile(dir, 'root/billing/_/engine/tsconfig.json', '{}');
    expect(enclosingProjects(nested).map((p) => p.dir)).toEqual([dir]);
    const io = fakeIo({ cwd: nested });
    expect(await initCommand(testContext(), io, ['--yes'], { skillSource: null })).toBe(0);
    expect(JSON.parse(readFile(dir, 'root/billing/_/engine/buckets.config.json')).alias).toMatch(/^@root-[a-z2-9]{8}$/);
    expect(fileExists(dir, 'root/billing/_/engine/.claude')).toBe(false);
    expect(io.out).toContain('Skipped the Claude Code hooks and the skill');
    expect(io.out).toContain(`run \`buckets refresh\` in ${dir}`);
  });

  it('refuses an alias that an enclosing project uses', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const nested = path.join(dir, 'root/billing/_/engine');
    writeFile(dir, 'root/billing/_/engine/x.txt', '');
    const io = fakeIo({ cwd: nested, interactive: true, answers: ['', '@root', ''] });
    expect(await initCommand(testContext(), io, [], { skillSource: null, random: () => 2 })).toBe(1);
    expect(io.err).toContain('already the alias of an enclosing project');
    expect(fileExists(dir, 'root/billing/_/engine/buckets.config.json')).toBe(false);
    expect(io.questions.some((q) => q.includes('[@root-cccccccc]'))).toBe(true);
    expect(io.err).toContain('such as "@root-cccccccc"');
  });

  it('refuses a folder inside the bucket tree that is not under a _/ folder', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    for (const where of ['root/billing', 'root/billing/_', 'root/dmz/log']) {
      const io = fakeIo({ cwd: path.join(dir, where) });
      expect(await initCommand(testContext(), io, ['--yes'], { skillSource: null })).toBe(1);
      expect(io.err).toContain("subfolder of a bucket's _/ folder");
    }
    expect(fileExists(dir, 'root/billing/buckets.config.json')).toBe(false);
  });
});

describe('buckets refresh with nested projects', () => {
  it('asks project by project and writes only the approved locks', async () => {
    const dir = await tree();
    writeFile(dir, 'root/mail/_/m.ts', 'export const m = 1;\n');
    writeFile(dir, `${NESTED}/root/jobs/_/j.ts`, 'export const j = 1;\n');
    const before = readFile(dir, `${NESTED}/buckets.lock.json`);
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['y', 'n'] });
    expect(await refreshCommand(testContext(), io, [])).toBe(1);
    expect(io.questions).toEqual(['Approve and write buckets.lock.json? [y/N] ', `Approve and write ${NESTED}/buckets.lock.json? [y/N] `]);
    expect(io.out).toContain(`== Project ${NESTED}`);
    const top = readLock(dir);
    expect(top.kind === 'ok' && top.lock.buckets).toContain('root/mail');
    expect(readFile(dir, `${NESTED}/buckets.lock.json`)).toBe(before);
  });

  it('refuses when a nested project breaks a rule', async () => {
    const dir = await tree();
    writeFile(dir, `${NESTED}/root/_/run.ts`, "import x from './x';\n");
    const io = fakeIo({ cwd: dir, interactive: true, answers: ['y'] });
    expect(await refreshCommand(testContext(), io, [])).toBe(1);
    expect(io.err).toContain('in every project');
    expect(io.questions).toEqual([]);
  });

  it('says everything is up to date across projects', async () => {
    const dir = await tree();
    const io = fakeIo({ cwd: dir, interactive: true });
    expect(await refreshCommand(testContext(), io, [])).toBe(0);
    expect(io.out).toContain('up to date in 2 projects');
  });
});

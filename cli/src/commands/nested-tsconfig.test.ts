// Nested projects and tsconfig.json: init keeps a nested project out of the enclosing build, and the check reports
// a nested project without its own tsconfig.json, an enclosing build that still reaches it, a root folder outside the
// build, and an alias that an enclosing project already uses.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultContext } from '../api.js';
import { runCheck } from '../core/check.js';
import { runRecursiveCheck } from '../core/recursive.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { checkProject, fakeIo, testContext } from '../testing/harness.js';
import { initCommand } from './init.js';

afterEach(cleanupProjects);

const NESTED = 'root/billing/_/engine';
const OPTIONS = '"compilerOptions": { "strict": true, "noUnusedLocals": true, "paths": { "@root/*": ["./root/*"] } }';
const PARENT_TSCONFIG = `{
  // the parent build
  ${OPTIONS},
  "include": ["root"]
}
`;
const NESTED_PROJECT: Record<string, string> = {
  [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
  [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
  [`${NESTED}/tsconfig.json`]: '{ "compilerOptions": { "noUnusedLocals": true, "paths": { "@engine/*": ["./root/*"] } }, "include": ["root"] }\n',
  [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
};

function projectConfigMessages(report: { violations: { rule: string; file: string; message: string; project?: string }[] }, project = '.'): string[] {
  return report.violations.filter((v) => v.rule === 'project-config' && (v.project ?? '.') === project).map((v) => `${v.file}: ${v.message}`);
}

describe('buckets init in a _/ folder of another project', () => {
  it('adds the nested project to exclude in the tsconfig.json of the enclosing project, keeping its comments', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'tsconfig.json': PARENT_TSCONFIG, [`${NESTED}/tsconfig.json`]: '{}\n' });
    const io = fakeIo({ cwd: path.join(dir, NESTED) });
    expect(await initCommand(defaultContext(), io, ['--yes'], { skillSource: null })).toBe(0);
    expect(io.out).toContain(`Updated ${path.join(dir, 'tsconfig.json')}: exclude ${NESTED} (nested project)`);
    const text = readFile(dir, 'tsconfig.json');
    expect(text).toContain('// the parent build');
    expect(text).toContain(`"include": ["root"],\n  "exclude": ["${NESTED}"]\n}`);

    // The enclosing project now passes its config check, and a second init changes nothing there.
    const { report } = await runRecursiveCheck(defaultContext(), dir);
    expect(projectConfigMessages(report)).toEqual([]);
    expect(projectConfigMessages(report, NESTED)).toEqual([]);
    const again = fakeIo({ cwd: path.join(dir, NESTED) });
    expect(await initCommand(defaultContext(), again, ['--yes'], { skillSource: null })).toBe(0);
    expect(again.out).not.toContain(`Updated ${path.join(dir, 'tsconfig.json')}`);
    expect(readFile(dir, 'tsconfig.json')).toBe(text);
  });

  it('prints the exact line to add when the edit could lose a comment', async () => {
    const tsconfig = `{ ${OPTIONS}, "include": ["root"], "exclude": [ /* nothing yet */ ] }\n`;
    const dir = makeProject({ ...LOGGER_PROJECT, 'tsconfig.json': tsconfig, [`${NESTED}/tsconfig.json`]: '{}\n' });
    const io = fakeIo({ cwd: path.join(dir, NESTED) });
    expect(await initCommand(defaultContext(), io, ['--yes'], { skillSource: null })).toBe(0);
    expect(io.out).toContain(`add this line to the "exclude" array of tsconfig.json: "${NESTED}"`);
    expect(readFile(dir, 'tsconfig.json')).toBe(tsconfig);
  });

  it('sends the projects already nested in a project to its adapter init', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_PROJECT });
    const ctx = testContext();
    // Without a skill to copy, init ends with 1; the adapter call happens before that.
    await initCommand(ctx, fakeIo({ cwd: dir }), ['--yes'], { skillSource: null });
    expect(ctx.adapter.initCalls[0]!.nestedProjects).toEqual([NESTED]);
  });
});

describe('check with nested projects and tsconfig.json', () => {
  it('reports no-tsconfig for a nested project without its own tsconfig.json', async () => {
    const files: Record<string, string> = { ...LOGGER_PROJECT, ...NESTED_PROJECT, 'tsconfig.json': PARENT_TSCONFIG.replace('"include": ["root"]', `"include": ["root"], "exclude": ["${NESTED}"]`) };
    delete files[`${NESTED}/tsconfig.json`];
    const dir = makeProject(files);
    const { report } = await runRecursiveCheck(defaultContext(), dir);
    expect(report.exitCode).toBe(3);
    expect(report.environment?.code).toBe('no-tsconfig');
    expect(report.environment?.message).toContain(`In the nested project ${NESTED}: adapter-ts: ${path.join(dir, NESTED, 'tsconfig.json')} does not exist.`);
    expect(report.environment?.message).toContain('and so does a nested project');
    expect(report.projects).toEqual([
      { path: '.', exitCode: 2 },
      { path: NESTED, exitCode: 3 },
    ]);
  });

  it('reports project-config in the enclosing project while its tsconfig.json still includes a nested project', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_PROJECT, 'tsconfig.json': PARENT_TSCONFIG });
    const result = await runCheck(defaultContext(), dir);
    expect(projectConfigMessages(result.report)).toEqual([
      `tsconfig.json: The effective "include" of tsconfig.json reaches the nested project ${NESTED}, so the TypeScript build of this project also compiles the files of that project, with the settings and alias of this one. Add "${NESTED}" to "exclude" in tsconfig.json. slopbuckets needs this project setting to check the rules. Fix tsconfig.json, or run \`buckets init\`, which applies the settings it can and says what to change by hand.`,
    ]);
    writeFile(dir, 'tsconfig.json', PARENT_TSCONFIG.replace('"include": ["root"]', `"include": ["root"], "exclude": ["${NESTED}/**"]`));
    expect(projectConfigMessages((await runCheck(defaultContext(), dir)).report)).toEqual([]);
  });

  it('sends the nested project folders in the analyze request', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_PROJECT });
    const ctx = testContext();
    await checkProject(dir, {}, ctx);
    expect(ctx.adapter.analyzeCalls[0]!.nestedProjects).toEqual([NESTED]);
    const plain = testContext();
    await checkProject(makeProject(LOGGER_PROJECT), {}, plain);
    expect(plain.adapter.analyzeCalls[0]!).not.toHaveProperty('nestedProjects');
  });

  it('reports project-config when the root folder is outside the build', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'tsconfig.json': PARENT_TSCONFIG.replace('"include": ["root"]', '"include": ["src"]') });
    expect(projectConfigMessages((await runCheck(defaultContext(), dir)).report)).toEqual([
      expect.stringContaining('tsconfig.json: The effective "include" and "files" of tsconfig.json (after "extends") do not reach root/, so the TypeScript build leaves the bucket code out. Add "root" to "include" in tsconfig.json.'),
    ]);
    writeFile(dir, 'tsconfig.json', `{ "compilerOptions": { "strict": true, "noUnusedLocals": true, "rootDir": "./src", "paths": { "@root/*": ["./root/*"] } } }\n`);
    expect(projectConfigMessages((await runCheck(defaultContext(), dir)).report)).toEqual([
      expect.stringContaining('compilerOptions.rootDir is "src", which does not contain root/'),
    ]);
  });
});

describe('check and the alias of an enclosing project', () => {
  it('reports config-invalid on a nested buckets.config.json that reuses the alias of an enclosing project', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_PROJECT, [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@root" }\n' });
    const { report } = await runRecursiveCheck(testContext(), dir);
    const reuse = report.violations.filter((v) => v.rule === 'config-invalid');
    expect(reuse).toEqual([expect.objectContaining({ file: 'buckets.config.json', project: NESTED })]);
    expect(reuse[0]!.message).toContain(`The alias "@root" is also the alias of the enclosing project ${dir}.`);
    expect(report.projects).toEqual([
      { path: '.', exitCode: 2 },
      { path: NESTED, exitCode: 1 },
    ]);
    // A check that starts in the nested project finds it too.
    const inside = await checkProject(path.join(dir, NESTED));
    expect(inside.report.violations.map((v) => `${v.rule} ${v.file}`)).toContain('config-invalid buckets.config.json');
  });

  it('compares with every enclosing project, not only the nearest', async () => {
    const inner = `${NESTED}/root/_/inner`;
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_PROJECT, [`${inner}/buckets.config.json`]: '{ "alias": "@root" }\n', [`${inner}/root/_/i.ts`]: 'export const i = 1;\n' });
    const { report } = await runRecursiveCheck(testContext(), dir);
    expect(report.violations.filter((v) => v.rule === 'config-invalid').map((v) => v.project)).toEqual([`${NESTED}/root/_/inner`]);
  });

  it('accepts distinct aliases', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, ...NESTED_PROJECT });
    const { report } = await runRecursiveCheck(testContext(), dir);
    expect(report.violations.filter((v) => v.rule === 'config-invalid')).toEqual([]);
  });
});

// The harness-neutral hook core, called directly: every deny and allow form of the Claude Code hook, without Claude's
// payload, plus the post-edit and stop reports.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { linkSync, rmSync, symlinkSync } from 'node:fs';
import type { AnalyzeResponse } from '@slopbuckets/adapter-ts';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '../core/types.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { approve, testContext } from '../testing/harness.js';
import { CONFIG_DENY_REASON, LOCK_DENY_REASON, postEdit, preTool, stop, STOP_INTRO, UPDATE_DENY_REASON, type ToolAction } from './core.js';
import { readSessionProjects, sessionStateFile } from './session.js';

const stateFiles: string[] = [];
afterEach(() => {
  for (const file of stateFiles.splice(0)) rmSync(file, { force: true });
  cleanupProjects();
});

function newSession(): string {
  const id = randomUUID();
  stateFiles.push(sessionStateFile(id)!);
  return id;
}

const NOWHERE = path.join(path.sep, 'nowhere', 'at', 'all');
const DENY = { decision: 'deny', reason: LOCK_DENY_REASON };
const CONFIG_DENY = { decision: 'deny', reason: CONFIG_DENY_REASON };
const UPDATE_DENY = { decision: 'deny', reason: UPDATE_DENY_REASON };
const ALLOW = { decision: 'allow' };
const shell = (command: string): ToolAction => ({ kind: 'shell', command });
const write = (...paths: string[]): ToolAction => ({ kind: 'write', paths });

describe('preTool: shell commands', () => {
  it.each([
    'buckets check',
    'ls',
    'buckets refresh --web',
    'npx slopbuckets refresh --web',
    'npx slopbuckets@0.1.0 refresh --web',
    'cd /repo && buckets refresh --web',
    'buckets refresh --web 2>&1',
    'buckets refresh --web &',
    'buckets refresh --web; echo done',
    'buckets   refresh\t--web',
    'buckets refresh "--web"',
    'buckets check && buckets refresh --web',
    'buckets refresh --web > out.txt',
    'buckets refresh --web > refresh.log 2>&1 &',
    'buckets refresh --web >refresh.log 2>&1 &',
    'buckets refresh --web>refresh.log',
    'buckets refresh --web >> refresh.log 2>> errors.log',
    'buckets refresh --web &> refresh.log &',
    'buckets refresh --web &>> refresh.log',
    'buckets refresh --web >| refresh.log',
    'buckets refresh --web >& refresh.log',
    'buckets refresh --web 2>&1 | tee refresh.log',
    'buckets refresh --web 2>&1 | tee -a refresh.log &',
    'buckets refresh --web > /dev/null 2>&1 &',
    'buckets refresh --web 1>&2',
    'buckets refresh --web 2>&-',
    'nohup buckets refresh --web > refresh.log 2>&1 &',
    'nohup npx slopbuckets refresh --web &',
    '(buckets refresh --web > refresh.log 2>&1 &)',
    'cd /repo && nohup buckets refresh --web > "logs/refresh.log" 2>&1 &',
    String.raw`buckets refresh --web > C:\temp\refresh.log 2>&1`,
    'npx slopbuckets refresh --web 2>&1 > .buckets/refresh.log & echo started',
    'buckets refresh --web; buckets check > check.log',
    'buckets refresh --web *>&1',
    'buckets refresh --web *> refresh.log',
    'buckets refresh --web 2>$null',
    'buckets refresh --web > $null',
    'buckets refresh --web *>&1 | Out-File refresh.log',
    'buckets refresh --web 3>&1 2>&1 > refresh.log',
    '& buckets refresh --web *> refresh.log',
    "& 'npx' slopbuckets refresh --web *>&1 &",
    'buckets.cmd refresh --web',
    'node cli/dist/index.js refresh --web',
    'npm exec slopbuckets -- refresh --web',
    'pnpm dlx slopbuckets refresh --web',
    'node scripts/build.js',
    'npx vitest run refresh-web',
    'npm test -- refresh',
    'ls *',
    'cat *.json',
    'prettier --write "**/*.ts"',
    'git show bugfix~1',
    'ls src/[a-z]*.ts',
    'cat package.json',
  ])('allows %j', (command) => {
    expect(preTool({ cwd: NOWHERE, action: shell(command) })).toEqual(ALLOW);
  });

  it.each([
    'buckets refresh',
    'buckets  refresh',
    'buckets refresh --webx',
    'buckets refresh --web-ui',
    'buckets refresh --WEB',
    'buckets refresh --web --yes',
    'buckets refresh --yes --web',
    'buckets refresh -- --web',
    'buckets refresh --web; buckets refresh',
    'buckets refresh --web && buckets refresh',
    'buckets refresh --web || buckets refresh',
    'buckets refresh --web | buckets refresh',
    'buckets refresh --web & buckets refresh',
    'buckets refresh --web\nbuckets refresh',
    'buckets refresh --web $(buckets refresh)',
    'buckets refresh --web`buckets refresh`',
    'buckets refresh --web#',
    'echo y | buckets refresh',
    'npx slopbuckets refresh',
    'npx slopbuckets@latest refresh',
    'npx slopbuckets@0.1.0 refresh --webx',
    'Buckets Refresh',
    '"buckets" refresh',
    "buckets 'refresh'",
    String.raw`b\uckets refresh`,
    'b^uckets refresh',
    'buckets refreshx --web',
    'buckets refresh --web buckets.lock.json',
    'cat buckets.lock.json',
    'Get-Content buckets.lock.json',
    'buckets refresh --web > buckets.lock.json',
    'buckets refresh --web >> ./buckets.lock.json',
    'buckets refresh --web 2> buckets.lock.json',
    'buckets refresh --web *> buckets.lock.json',
    'buckets refresh --web > BUCKET~1.JSO',
    'buckets refresh --web > bucket*',
    'buckets refresh --web 2>&1 | tee buckets.lock.json',
    'buckets refresh --web > out.txt --yes',
    'buckets refresh --web 2>&1 --yes',
    'buckets refresh --web > out.txt extra',
    'buckets refresh --web >',
    'buckets refresh --web > out.txt 2>',
    'buckets refresh --web2>&1',
    'buckets refresh --web*>&1',
    'buckets refresh --web < answers.txt',
    'buckets refresh --web 0< answers.txt',
    'buckets refresh --web <<< y',
    'buckets refresh --web > $(buckets refresh)',
    'buckets refresh --web > `buckets refresh`',
    'buckets refresh --web > out.txt; buckets refresh',
    'buckets refresh --web > out.txt 2>&1 & buckets refresh',
    'nohup buckets refresh > refresh.log 2>&1 &',
    'nohup buckets refresh --yes > refresh.log &',
    'buckets refresh > out.txt --web',
    'buckets refresh 2>&1 --web',
    'cat bucket*',
    'cat buckets.lock.js?n',
    'rm ./*.lock.json',
    'cp x b[u]ckets.lock.json',
    'echo {} > bucket[s].lock.json',
    'cat bucket{s,}.lock.json',
    'Get-Content .\\buckets.*.json',
    'Set-Content -Path buckets.lock.js* -Value x',
    'type BUCKET~1.JSO',
    'copy x C:\\p\\BU3F2A~1.JSO',
    'type BUCKET~?.JSO',
    'cat "buckets".lock.json',
    'cat b"ucke"ts.lock.json',
    'cat b^uckets.lock.json',
    'cat b\\uckets.lock.json',
    'buckets.cmd refresh',
    'buckets.CMD refresh --yes',
    'buckets.ps1 refresh',
    'slopbuckets.cmd refresh',
    'node cli/dist/index.js refresh',
    'node C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\slopbuckets\\dist\\index.js refresh',
    'node "./node_modules/slopbuckets/dist/index.js" refresh --webx',
    'npx tsx cli/src/cli.ts refresh',
    'npm exec slopbuckets -- refresh',
    'npm exec --yes slopbuckets -- refresh',
    'npm exec --package=slopbuckets -- buckets refresh',
    'npx --prefix /tmp/x slopbuckets refresh',
    'npx slopbuckets --cwd /repo refresh',
    'pnpm dlx slopbuckets refresh',
  ])('denies %j inside and outside a project', (command) => {
    expect(preTool({ cwd: NOWHERE, action: shell(command) })).toEqual(DENY);
    const dir = makeProject(LOGGER_PROJECT);
    expect(preTool({ projectDir: dir, cwd: dir, action: shell(command) })).toEqual(DENY);
  });

  it('allows anything that is neither a write nor a shell command', () => {
    expect(preTool({ cwd: NOWHERE, action: { kind: 'other' } })).toEqual(ALLOW);
  });
});

describe('preTool: file writes', () => {
  it.each([
    '/p/buckets.lock.json',
    'C:\\p\\buckets.lock.json',
    'buckets.lock.json',
    'C:\\p\\buckets.lock.json::$DATA',
    'buckets.lock.json:$DATA',
    '/p/buckets.lock.json.',
    '/p/buckets.lock.json ',
    'C:\\p\\BUCKETS.LOCK.JSON. ',
  ])('denies a write to %j inside a project', (file) => {
    const dir = makeProject(LOGGER_PROJECT);
    expect(preTool({ projectDir: dir, cwd: dir, action: write(file) })).toEqual(DENY);
  });

  it('denies when any path of a multi-file write is a lock, and allows other files', () => {
    const dir = makeProject(LOGGER_PROJECT);
    expect(preTool({ projectDir: dir, cwd: dir, action: write('root/_/main.ts', 'buckets.lock.json') })).toEqual(DENY);
    expect(preTool({ projectDir: dir, cwd: dir, action: write('root/_/main.ts', 'buckets.config.json') })).toEqual(CONFIG_DENY);
    expect(preTool({ projectDir: dir, cwd: dir, action: write('root/_/main.ts') })).toEqual(ALLOW);
    expect(preTool({ projectDir: dir, cwd: dir, action: write() })).toEqual(ALLOW);
  });

  it('finds the session project from projectDir, walking up, and resolves relative paths from cwd', () => {
    const dir = makeProject(LOGGER_PROJECT);
    const outside = makeProject({}, false);
    expect(preTool({ projectDir: path.join(dir, 'root', 'log'), cwd: outside, action: write('buckets.lock.json') })).toEqual(DENY);
    // Outside every project, a lock name with no project around it is allowed.
    expect(preTool({ cwd: outside, action: write('buckets.lock.json') })).toEqual(ALLOW);
  });

  it('denies hard links and symbolic links of the lock and of a nested lock, by identity', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/log/_/engine/buckets.config.json': '{ "root": "root" }\n', 'root/log/_/engine/root/_/run.ts': 'export const run = 1;\n' });
    await approve(path.join(dir, 'root/log/_/engine'));
    await approve(dir);
    const hard = path.join(dir, 'root', 'log', '_', 'notes.json');
    linkSync(path.join(dir, 'buckets.lock.json'), hard);
    const at = (file: string) => preTool({ projectDir: dir, cwd: dir, action: write(file) });
    expect(at(hard)).toEqual(DENY);
    expect(at('root/log/_/notes.json')).toEqual(DENY);
    const nestedHard = path.join(dir, 'root', 'log', '_', 'data.json');
    linkSync(path.join(dir, 'root/log/_/engine/buckets.lock.json'), nestedHard);
    expect(at(nestedHard)).toEqual(DENY);
    expect(at(path.join(dir, 'root/log/_/engine/buckets.lock.json'))).toEqual(DENY);
    expect(at(path.join(dir, 'root', 'log', '_', 'other.json'))).toEqual(ALLOW);
    try {
      const soft = path.join(dir, 'root', 'log', '_', 'soft.json');
      symlinkSync(path.join(dir, 'buckets.lock.json'), soft, 'file');
      expect(at(soft)).toEqual(DENY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('above the projects, denies a lock of a project below the session and a hard link to it, and allows files outside every project', async () => {
    const parent = makeProject({ 'notes.md': '# notes\n', ...Object.fromEntries(Object.entries(LOGGER_PROJECT).map(([f, c]) => [`a/${f}`, c])), 'a/buckets.config.json': '{ "root": "root" }\n' }, false);
    const a = path.join(parent, 'a');
    await approve(a);
    const session = newSession();
    const scope = { projectDir: parent, cwd: parent, sessionId: session };
    expect(preTool({ ...scope, action: write('a/buckets.lock.json') })).toEqual(DENY);
    expect(preTool({ ...scope, action: write(path.join(a, 'buckets.lock.json.')) })).toEqual(DENY);
    const hard = path.join(parent, 'copy.json');
    linkSync(path.join(a, 'buckets.lock.json'), hard);
    expect(preTool({ ...scope, action: write(hard) })).toEqual(DENY);
    expect(preTool({ ...scope, action: write('notes.md', 'buckets.lock.json') })).toEqual(ALLOW);
  });

  it('above the projects, records the project of a shell command, from the action cwd first', () => {
    const parent = makeProject({ 'a/buckets.config.json': '{ "root": "root" }\n', 'b/buckets.config.json': '{ "root": "root" }\n' }, false);
    const session = newSession();
    expect(preTool({ projectDir: parent, cwd: path.join(parent, 'a'), sessionId: session, action: shell('ls') })).toEqual(ALLOW);
    expect(preTool({ projectDir: parent, cwd: parent, sessionId: session, action: { kind: 'shell', command: 'ls', cwd: 'b' } })).toEqual(ALLOW);
    expect(readSessionProjects(sessionStateFile(session)!).projects).toEqual([path.join(parent, 'a'), path.join(parent, 'b')]);
  });

  it('never throws on odd paths', () => {
    for (const file of ['', ':', '::$DATA', '\0', 'C:', '\\\\?\\', 'a/'.repeat(500)]) {
      expect(() => preTool({ projectDir: NOWHERE, cwd: NOWHERE, action: write(file) })).not.toThrow();
    }
  });
});

describe('preTool: buckets.config.json', () => {
  const NESTED = { ...LOGGER_PROJECT, 'root/log/_/engine/buckets.config.json': '{ "root": "root" }\n', 'root/log/_/engine/root/_/run.ts': 'export const run = 1;\n' };

  it.each([
    'buckets.config.json',
    'C:\\p\\buckets.config.json',
    'buckets.config.json::$DATA',
    'BUCKETS.CONFIG.JSON. ',
    'root/log/_/engine/buckets.config.json',
  ])('denies a write to %j inside a project, root or nested, with the config reason', (file) => {
    const dir = makeProject(NESTED);
    expect(preTool({ projectDir: dir, cwd: dir, action: write(file) })).toEqual(CONFIG_DENY);
  });

  it('denies hard links and symbolic links of the root config and of a nested config, by identity', async () => {
    const dir = makeProject(NESTED);
    await approve(path.join(dir, 'root/log/_/engine'));
    await approve(dir);
    const at = (file: string) => preTool({ projectDir: dir, cwd: dir, action: write(file) });
    const hard = path.join(dir, 'root', 'log', '_', 'settings.json');
    linkSync(path.join(dir, 'buckets.config.json'), hard);
    expect(at(hard)).toEqual(CONFIG_DENY);
    const nestedHard = path.join(dir, 'root', 'log', '_', 'engine-settings.json');
    linkSync(path.join(dir, 'root/log/_/engine/buckets.config.json'), nestedHard);
    expect(at(nestedHard)).toEqual(CONFIG_DENY);
    try {
      const soft = path.join(dir, 'root', 'log', '_', 'soft-config.json');
      symlinkSync(path.join(dir, 'root/log/_/engine/buckets.config.json'), soft, 'file');
      expect(at(soft)).toEqual(CONFIG_DENY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it.each([
    'cat buckets.config.json',
    'sed -i s/deny/allow/ buckets.config.json',
    'echo {} > root/log/_/engine/buckets.config.json',
    'Set-Content -Path .\\buckets.config.json -Value x',
    'cat *.config.json',
    'cat b"ucke"ts.config.json',
  ])('denies the shell command %j with the config reason', (command) => {
    expect(preTool({ cwd: NOWHERE, action: shell(command) })).toEqual(CONFIG_DENY);
    const dir = makeProject(NESTED);
    expect(preTool({ projectDir: dir, cwd: dir, action: shell(command) })).toEqual(CONFIG_DENY);
  });

  it.each([
    'buckets update',
    'buckets update 1.2.0',
    'buckets update v1.2.0 --yes',
    'buckets update --yes',
    'buckets update -y',
    'npx slopbuckets update',
    'npx slopbuckets@latest update --yes',
    'pnpm exec buckets update',
    'pnpm dlx slopbuckets update',
    'yarn buckets update',
    'bunx slopbuckets update',
    'npm exec slopbuckets -- update',
    'node node_modules/slopbuckets/dist/index.js update',
    'buckets.cmd update --yes',
    'Buckets Update',
    '"buckets" update',
    'echo y | buckets update',
    'buckets update --check; buckets update',
    'buckets update --json && buckets update --yes',
    'buckets update > --check',
    'buckets update $(echo --check)',
    'buckets update --checkx',
    'buckets update --CHECK',
    'buckets update --yes # --check',
    'buckets update --yes `--check`',
    'buckets update --yes <# --check #>',
    'buckets update --yes "$(echo --check)"',
    'buckets update (Write-Output --check)',
    'node $(which buckets) update --yes',
    'node `which buckets` update --yes',
    '& (Get-Command buckets).Source update',
    'bash -c "buckets update --yes"',
    "pwsh -NoProfile -Command 'buckets update'",
    'cmd /c buckets update',
    'eval "buckets update"',
    'echo "$(buckets update)"',
    'echo `buckets update`',
    'FOO=1 buckets update',
    'sudo -E buckets update',
    'nohup buckets update &',
    'echo y | xargs buckets update',
    'C:\\tools\\buckets.cmd update',
    './node_modules/.bin/buckets update',
  ])('denies the installing update %j with the update reason', (command) => {
    expect(preTool({ cwd: NOWHERE, action: shell(command) })).toEqual(UPDATE_DENY);
    const dir = makeProject(NESTED);
    expect(preTool({ projectDir: dir, cwd: dir, action: shell(command) })).toEqual(UPDATE_DENY);
  });

  it.each([
    'buckets update --check',
    'buckets update --json',
    'buckets update 1.2.0 --check',
    'buckets update --yes --json',
    'npx slopbuckets update --check',
    'pnpm exec buckets update --json',
    'buckets update --check > update.log 2>&1 &',
    'buckets update 2>&1 --json',
    'buckets update "--check"',
    'npm update',
    'apt-get update && buckets check',
    'git commit -m "Update the access docs"',
    'buckets check --file root/_/update.ts',
    'npm run update-deps',
    'buckets link update shared',
    'buckets update --check # weekly',
    'buckets update --json <# report only #>',
    'gcloud storage buckets update gs://my-bucket --versioning',
    'git commit -m "docs: explain buckets update"',
    'grep -rn "buckets update" docs',
    'echo "run buckets update; then buckets update --yes"',
    'bash -c "buckets update --check"',
  ])('allows %j', (command) => {
    expect(preTool({ cwd: NOWHERE, action: shell(command) })).toEqual(ALLOW);
  });

  it('gives the lock reason when a command names both files', () => {
    expect(preTool({ cwd: NOWHERE, action: shell('cp buckets.config.json buckets.lock.json') })).toEqual(DENY);
  });

  it('above the projects, denies the config of a project below the session and of its nested project', async () => {
    const parent = makeProject({ ...Object.fromEntries(Object.entries(NESTED).map(([f, c]) => [`a/${f}`, c])), 'a/buckets.config.json': '{ "root": "root" }\n' }, false);
    const scope = { projectDir: parent, cwd: parent, sessionId: newSession() };
    expect(preTool({ ...scope, action: write('a/buckets.config.json') })).toEqual(CONFIG_DENY);
    expect(preTool({ ...scope, action: write('a/root/log/_/engine/buckets.config.json') })).toEqual(CONFIG_DENY);
    await approve(path.join(parent, 'a'));
    const hard = path.join(parent, 'copy.json');
    linkSync(path.join(parent, 'a', 'buckets.config.json'), hard);
    expect(preTool({ ...scope, action: write(hard) })).toEqual(CONFIG_DENY);
  });
});

describe('postEdit', () => {
  it('reports the violations of an edited file in the root bucket folder, and nothing for clean or outside files', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n" });
    const ctx = testContext();
    const bad = await postEdit(ctx, { projectDir: dir, cwd: dir, paths: ['root/_/main.ts'] });
    expect(bad.feedback).toContain('buckets check --file root/_/main.ts found problems');
    expect(bad.feedback).toContain('import-relative');
    expect(await postEdit(ctx, { projectDir: dir, cwd: dir, paths: [path.join(dir, 'root/log/_/logger.ts')] })).toEqual({});
    expect(await postEdit(ctx, { projectDir: dir, cwd: dir, paths: [path.join(dir, 'README.md')] })).toEqual({});
    expect(await postEdit(ctx, { projectDir: dir, cwd: dir, paths: [] })).toEqual({});
  });

  it('joins the reports of several files, as an apply_patch call produces', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/_/main.ts': "import x from './x';\n", 'root/log/_/logger.ts': "import y from './y';\nexport function logger() {}\n" });
    const result = await postEdit(testContext(), { projectDir: dir, cwd: dir, paths: ['root/_/main.ts', 'root/log/_/logger.ts'] });
    expect(result.feedback).toContain('--file root/_/main.ts');
    expect(result.feedback).toContain('--file root/log/_/logger.ts');
  });

  it('above the projects, records the project of every path and checks only `paths`', async () => {
    const parent = makeProject({ 'a/buckets.config.json': '{ "root": "root" }\n', ...Object.fromEntries(Object.entries(LOGGER_PROJECT).map(([f, c]) => [`a/${f}`, c])), 'a/root/_/main.ts': "import x from './x';\n", 'b/buckets.config.json': '{ "root": "root" }\n' }, false);
    const session = newSession();
    const result = await postEdit(testContext(), { projectDir: parent, cwd: parent, sessionId: session, paths: ['a/root/_/main.ts'], touched: ['b/notes.ipynb', 'loose.md'] });
    expect(result.feedback).toContain(`in the project ${path.join(parent, 'a')}`);
    expect(readSessionProjects(sessionStateFile(session)!).projects).toEqual([path.join(parent, 'a'), path.join(parent, 'b')]);
  });

  it('reports a crash inside a project and asks the agent to tell the human', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const ctx = testContext();
    const broken: Context = { ...ctx, adapter: { ...ctx.adapter, analyze: async () => null as unknown as AnalyzeResponse } };
    const result = await postEdit(broken, { projectDir: dir, cwd: dir, paths: ['root/_/main.ts'] });
    expect(result.feedback).toContain('crashed');
    expect(result.feedback).toContain('Report this error to the human');
    expect(result.error).toContain('TypeError');
  });
});

describe('stop', () => {
  it('blocks with the report and the intro of its exit code, for a stop and a subagent stop', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    for (const subagent of [false, true]) {
      const result = await stop(testContext(), { projectDir: dir, cwd: dir, active: false, subagent });
      expect(result.block?.startsWith(STOP_INTRO[2])).toBe(true);
      expect(result.block).toContain('lock-missing');
    }
  });

  it('lets the agent go when active, without running anything, and when the check passes', async () => {
    const broken = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': '{ broken' });
    expect(await stop(testContext(), { projectDir: broken, cwd: broken, active: true, subagent: false })).toEqual({});
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    expect(await stop(testContext(), { projectDir: dir, cwd: dir, active: false, subagent: false })).toEqual({});
  });

  it('above the projects, checks only the recorded projects, in one report', async () => {
    const files: Record<string, string> = {};
    for (const name of ['a', 'b']) {
      files[`${name}/buckets.config.json`] = '{ "root": "root" }\n';
      for (const [file, content] of Object.entries(LOGGER_PROJECT)) files[`${name}/${file}`] = content;
    }
    const parent = makeProject(files, false);
    const session = newSession();
    const scope = { projectDir: parent, cwd: parent, sessionId: session };
    expect(await stop(testContext(), { ...scope, active: false, subagent: false })).toEqual({});
    await postEdit(testContext(), { ...scope, paths: [], touched: ['a/root/_/x.ts'] });
    const result = await stop(testContext(), { ...scope, active: false, subagent: false });
    expect(result.block).toContain('buckets check failed in the project this session changed.');
    expect(result.block).toContain(`--- Project folder: ${path.join(parent, 'a')}`);
    expect(result.block).not.toContain(path.join(parent, 'b'));
  });
});

// The hooks in a session opened in a folder above the projects: per-file project lookup, session tracking and the
// combined stop check.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { hookCommand, LOCK_DENY_REASON } from './hook.js';
import { MAX_STATE_BYTES, projectsBelow, readSessionProjects, recordSessionProject, sessionStateFile } from './hook-session.js';

const stateFiles: string[] = [];

afterEach(() => {
  for (const file of stateFiles.splice(0)) rmSync(file, { force: true });
  cleanupProjects();
});

const DENY = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON } })}\n`;

/** A new session id and its state file, removed after the test. */
function newSession(): { id: string; file: string } {
  const id = randomUUID();
  const file = sessionStateFile(id)!;
  stateFiles.push(file);
  return { id, file };
}

/** A folder with the projects a/ and b/, both copies of LOGGER_PROJECT without a lock, and a loose notes.md. */
function twoProjects(): { parent: string; a: string; b: string } {
  const files: Record<string, string> = { 'notes.md': '# notes\n' };
  for (const name of ['a', 'b']) {
    files[`${name}/buckets.config.json`] = '{ "root": "root" }\n';
    files[`${name}/package.json`] = JSON.stringify({ name: `fixture-${name}`, dependencies: { axios: '1.0.0' } });
    for (const [file, content] of Object.entries(LOGGER_PROJECT)) files[`${name}/${file}`] = content;
  }
  const parent = makeProject(files, false);
  return { parent, a: path.join(parent, 'a'), b: path.join(parent, 'b') };
}

async function hook(event: string, input: Record<string, unknown>, session: string) {
  const io = fakeIo({ cwd: session, stdin: JSON.stringify({ cwd: session, ...input }), env: { CLAUDE_PROJECT_DIR: session } });
  const code = await hookCommand(testContext(), io, [event]);
  return { code, out: io.out, err: io.err };
}

function blockReason(out: string): string {
  const output = JSON.parse(out) as { decision: string; reason: string };
  expect(output.decision).toBe('block');
  return output.reason;
}

const edit = (file_path: string) => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'a', new_string: 'b' } });
const write = (file_path: string) => ({ tool_name: 'Write', tool_input: { file_path, content: '{}' } });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

describe('a session opened above two projects', () => {
  it('checks at stop only the project the session edited', async () => {
    const { parent, a, b } = twoProjects();
    const session = newSession();
    expect(await hook('stop', { session_id: session.id }, parent)).toEqual({ code: 0, out: '', err: '' });

    const post = await hook('post-tool-use', { session_id: session.id, ...edit(path.join(a, 'root/_/main.ts')) }, parent);
    expect(post).toEqual({ code: 0, out: '', err: '' });
    expect(readSessionProjects(session.file).projects).toEqual([a]);

    const stop = await hook('stop', { session_id: session.id, stop_hook_active: false }, parent);
    const reason = blockReason(stop.out);
    expect(reason).toContain('buckets check failed in the project this session changed.');
    expect(reason).toContain(`--- Project folder: ${a}`);
    expect(reason).not.toContain(`--- Project folder: ${b}`);
    expect(reason).toContain('lock-missing');
    expect(reason).toContain('differs from its buckets.lock.json');

    // The second attempt to stop passes, for both stop hooks.
    expect(await hook('stop', { session_id: session.id, stop_hook_active: true }, parent)).toEqual({ code: 0, out: '', err: '' });
    expect(await hook('subagent-stop', { session_id: session.id, stop_hook_active: true }, parent)).toEqual({ code: 0, out: '', err: '' });
    expect(blockReason((await hook('subagent-stop', { session_id: session.id }, parent)).out)).toContain(a);
  });

  it('writes nothing at stop when every recorded project passes', async () => {
    const { parent, a } = twoProjects();
    await approve(a);
    const session = newSession();
    await hook('post-tool-use', { session_id: session.id, ...edit(path.join(a, 'root/_/main.ts')) }, parent);
    expect(await hook('stop', { session_id: session.id }, parent)).toEqual({ code: 0, out: '', err: '' });
  });

  it('records the project of a shell command from its cwd and checks both projects in one report', async () => {
    const { parent, a, b } = twoProjects();
    const session = newSession();
    await hook('post-tool-use', { session_id: session.id, ...edit(path.join(a, 'root/_/main.ts')) }, parent);
    expect(await hook('pre-tool-use', { session_id: session.id, cwd: path.join(b, 'root'), ...bash('npm test') }, parent)).toEqual({ code: 0, out: '', err: '' });
    // A command run outside every project records nothing.
    await hook('pre-tool-use', { session_id: session.id, ...bash('ls') }, parent);
    expect(readSessionProjects(session.file).projects).toEqual([a, b]);
    const reason = blockReason((await hook('stop', { session_id: session.id }, parent)).out);
    expect(reason).toContain('buckets check failed in 2 of the 2 projects this session changed.');
    expect(reason).toContain(`--- Project folder: ${a}`);
    expect(reason).toContain(`--- Project folder: ${b}`);
  });

  it('runs the post-edit check in the project of the file and names that project', async () => {
    const { parent, a } = twoProjects();
    writeFileSync(path.join(a, 'root/_/main.ts'), "import x from './x';\n");
    const result = await hook('post-tool-use', { ...edit('a/root/_/main.ts') }, parent);
    const reason = blockReason(result.out);
    expect(reason).toContain('buckets check --file root/_/main.ts');
    expect(reason).toContain(`in the project ${a}`);
    expect(reason).toContain('import-relative');
    expect(existsSync(path.join(a, '.buckets'))).toBe(true);
  });

  it('checks a project nested in a recorded project once', async () => {
    const files: Record<string, string> = {
      'p/buckets.config.json': '{ "root": "root" }\n',
      'p/package.json': '{ "name": "p" }',
      'p/root/_/main.ts': 'export const main = 1;\n',
      'p/root/log/_/engine/buckets.config.json': '{ "root": "root", "alias": "@engine" }\n',
      'p/root/log/_/engine/package.json': '{ "name": "engine" }',
      'p/root/log/_/engine/root/_/run.ts': 'export const run = 1;\n',
    };
    const parent = makeProject(files, false);
    const p = path.join(parent, 'p');
    const engine = path.join(p, 'root/log/_/engine');
    const session = newSession();
    await hook('post-tool-use', { session_id: session.id, ...edit(path.join(engine, 'root/_/run.ts')) }, parent);
    await hook('post-tool-use', { session_id: session.id, ...edit(path.join(p, 'root/_/main.ts')) }, parent);
    expect(readSessionProjects(session.file).projects).toEqual([engine, p]);
    const reason = blockReason((await hook('stop', { session_id: session.id }, parent)).out);
    expect(reason).toContain('buckets check failed in the project this session changed.');
    expect(reason).toContain(`--- Project folder: ${p}`);
    expect(reason).not.toContain(`--- Project folder: ${engine}`);
  });
});

describe('files outside every project', () => {
  it('allows and records nothing', async () => {
    const { parent } = twoProjects();
    const session = newSession();
    const notes = path.join(parent, 'notes.md');
    expect(await hook('pre-tool-use', { session_id: session.id, ...edit(notes) }, parent)).toEqual({ code: 0, out: '', err: '' });
    expect(await hook('post-tool-use', { session_id: session.id, ...edit(notes) }, parent)).toEqual({ code: 0, out: '', err: '' });
    // A file named like the lock outside every project is not a lock.
    expect(await hook('pre-tool-use', { session_id: session.id, ...write(path.join(parent, 'buckets.lock.json')) }, parent)).toEqual({ code: 0, out: '', err: '' });
    expect(existsSync(session.file)).toBe(false);
    expect(await hook('stop', { session_id: session.id }, parent)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('the lock guard in a session above the projects', () => {
  it('denies writes to the lock of a project below the session folder, under any name', async () => {
    const { parent, a } = twoProjects();
    for (const input of [
      write(path.join(a, 'buckets.lock.json')),
      write('a/buckets.lock.json'),
      write(path.join(a, 'buckets.lock.json::$DATA')),
      write(path.join(a, 'BUCKETS.LOCK.JSON. ')),
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(a, 'buckets.lock.json') } },
      // Any file named like the lock inside a project is denied, as in a session opened in the project.
      write(path.join(a, 'root/log/_/buckets.lock.json')),
    ]) {
      expect((await hook('pre-tool-use', input, parent)).out).toBe(DENY);
    }
    expect((await hook('pre-tool-use', write(path.join(a, 'root/_/notes.json')), parent)).out).toBe('');
  });

  it('denies a hard link to a lock, placed outside every project or in another project', async () => {
    const files: Record<string, string> = {
      'a/buckets.config.json': '{ "root": "root" }\n',
      'a/package.json': '{ "name": "a" }',
      'a/root/_/main.ts': 'export const main = 1;\n',
      'a/root/log/_/logger.ts': 'export const log = 1;\n',
      'a/root/log/_/engine/buckets.config.json': '{ "root": "root", "alias": "@engine" }\n',
      'a/root/log/_/engine/package.json': '{ "name": "engine" }',
      'a/root/log/_/engine/root/_/run.ts': 'export const run = 1;\n',
      'b/buckets.config.json': '{ "root": "root" }\n',
      'b/package.json': '{ "name": "b" }',
      'b/root/_/main.ts': 'export const main = 1;\n',
      'notes.md': '# notes\n',
    };
    const parent = makeProject(files, false);
    const a = path.join(parent, 'a');
    await approve(path.join(a, 'root/log/_/engine'));
    await approve(a);
    const outside = path.join(parent, 'notes.json');
    linkSync(path.join(a, 'buckets.lock.json'), outside);
    const inB = path.join(parent, 'b', 'root', '_', 'data.json');
    linkSync(path.join(a, 'root/log/_/engine/buckets.lock.json'), inB);
    expect((await hook('pre-tool-use', write(outside), parent)).out).toBe(DENY);
    expect((await hook('pre-tool-use', write('notes.json'), parent)).out).toBe(DENY);
    expect((await hook('pre-tool-use', write(inB), parent)).out).toBe(DENY);
    expect((await hook('pre-tool-use', write(path.join(parent, 'notes.md')), parent)).out).toBe('');
  });

  it('keeps the shell rules for every command, inside a project or not', async () => {
    const { parent, a } = twoProjects();
    for (const command of ['cat a/buckets.lock.json', 'cat */bucket*', 'buckets refresh', 'npx slopbuckets refresh --yes']) {
      expect((await hook('pre-tool-use', bash(command), parent)).out).toBe(DENY);
      expect((await hook('pre-tool-use', { cwd: a, ...bash(command) }, parent)).out).toBe(DENY);
    }
    expect((await hook('pre-tool-use', { cwd: a, ...bash('buckets refresh --web > refresh.log 2>&1 &') }, parent)).out).toBe('');
    expect((await hook('pre-tool-use', bash('ls'), parent)).out).toBe('');
  });
});

describe('session state', () => {
  it('turns tracking off without a session id or with an unsafe one', async () => {
    const { parent, a } = twoProjects();
    for (const id of [undefined, '', '../escape', 'a/b', 'x'.repeat(200), 42]) {
      expect(sessionStateFile(id)).toBeNull();
      await hook('post-tool-use', { session_id: id, ...edit(path.join(a, 'root/_/main.ts')) }, parent);
      expect(await hook('stop', { session_id: id }, parent)).toEqual({ code: 0, out: '', err: '' });
    }
  });

  it('ignores a malformed or oversized state file and recreates it on the next record', async () => {
    const { parent, a, b } = twoProjects();
    for (const garbage of ['not json\n', '{"projects":[]}\n', '"relative/path"\n', `${JSON.stringify(a)}\n`.padEnd(MAX_STATE_BYTES + 10, ' ')]) {
      const session = newSession();
      mkdirSync(path.dirname(session.file), { recursive: true });
      writeFileSync(session.file, garbage);
      expect(await hook('stop', { session_id: session.id }, parent)).toEqual({ code: 0, out: '', err: '' });
      await hook('post-tool-use', { session_id: session.id, ...edit(path.join(b, 'root/_/main.ts')) }, parent);
      expect(readFileSync(session.file, 'utf8')).toBe(`${JSON.stringify(b)}\n`);
      expect(blockReason((await hook('stop', { session_id: session.id }, parent)).out)).toContain(`--- Project folder: ${b}`);
    }
  });

  it('does not record a project twice and never throws on a state file it cannot write', () => {
    const session = newSession();
    const dir = path.resolve('/some/project');
    recordSessionProject(session.file, dir);
    recordSessionProject(session.file, dir);
    expect(readSessionProjects(session.file)).toEqual({ ok: true, projects: [dir] });
    const blocked = path.join(path.dirname(session.file), `${randomUUID()}.jsonl`);
    mkdirSync(blocked, { recursive: true });
    try {
      expect(() => recordSessionProject(blocked, dir)).not.toThrow();
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  });

  it('drops a recorded project whose folder is gone', async () => {
    const { parent, a, b } = twoProjects();
    const session = newSession();
    await hook('post-tool-use', { session_id: session.id, ...edit(path.join(a, 'root/_/main.ts')) }, parent);
    await hook('post-tool-use', { session_id: session.id, ...edit(path.join(b, 'root/_/main.ts')) }, parent);
    rmSync(a, { recursive: true, force: true });
    const reason = blockReason((await hook('stop', { session_id: session.id }, parent)).out);
    expect(reason).not.toContain(`--- Project folder: ${a}`);
    expect(readSessionProjects(session.file).projects).toEqual([b]);
    rmSync(b, { recursive: true, force: true });
    expect(await hook('stop', { session_id: session.id }, parent)).toEqual({ code: 0, out: '', err: '' });
    expect(readSessionProjects(session.file).projects).toEqual([]);
  });

  it('records nothing when the session is opened inside a project', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const session = newSession();
    await hook('post-tool-use', { session_id: session.id, ...edit(path.join(dir, 'root/_/main.ts')) }, dir);
    await hook('pre-tool-use', { session_id: session.id, ...bash('ls') }, dir);
    expect(existsSync(session.file)).toBe(false);
  });
});

describe('projectsBelow', () => {
  it('finds projects without entering them, dot folders or node_modules', () => {
    const parent = makeProject(
      {
        'a/buckets.config.json': '{}',
        'a/sub/buckets.config.json': '{}',
        'group/c/buckets.config.json': '{}',
        'node_modules/d/buckets.config.json': '{}',
        '.cache/e/buckets.config.json': '{}',
      },
      false,
    );
    expect(projectsBelow(parent).sort()).toEqual([path.join(parent, 'a'), path.join(parent, 'group', 'c')].sort());
    expect(projectsBelow(parent, 0)).toEqual([]);
  });
});

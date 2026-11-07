// The Kiro adapter with Kiro payloads: PreToolUse for every tool (deny by exit code 2, context on stdout) and the CLI 3
// Stop hook, which blocks once per session.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookDecision, HookInput } from '../../contract/hooks.js';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { line, newSessionId, runAdapter } from './adapter-test-kit.js';
import { KIRO_HOOK_FILE, kiroAdapter, kiroV1Hooks } from './kiro.js';

const KIRO_V1_HOOKS = kiroV1Hooks();

const core = vi.hoisted(() => ({ decision: { kind: 'silent' } as HookDecision, inputs: [] as HookInput[], fail: false }));
vi.mock('../core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core.js')>()),
  hookCore: async (input: HookInput) => {
    core.inputs.push(input);
    if (core.fail) throw new Error('core crashed');
    // Like the real core: a stop that follows a block stays silent.
    return input.phase === 'stop' && input.stopHookActive ? { kind: 'silent' } : core.decision;
  },
}));

beforeEach(() => {
  core.decision = { kind: 'silent' };
  core.inputs = [];
  core.fail = false;
});
afterEach(cleanupProjects);

const QUIET = { code: 0, out: '', err: '' };

function payload(dir: string, tool: string, input: Record<string, unknown>, session = 'b7c1e2d4') {
  return { hook_event_name: 'preToolUse', cwd: dir, session_id: session, tool_name: tool, tool_input: input };
}

async function inputFor(dir: string, tool: string, args: Record<string, unknown>): Promise<HookInput> {
  await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, tool, args), dir);
  return core.inputs.at(-1)!;
}

describe('kiro pre-tool-use payloads', () => {
  it('turns fs_write into pre-edit with the new text', async () => {
    const dir = makeProject({ 'src/a.ts': 'const a = 1;\n' }, false);
    const file = path.join(dir, 'src/a.ts');
    expect(await inputFor(dir, 'fs_write', { command: 'create', path: 'src/b.ts', file_text: 'b\n' })).toEqual({
      phase: 'pre-edit',
      sessionId: 'b7c1e2d4',
      agentId: null,
      cwd: dir,
      root: dir,
      toolName: 'fs_write',
      edits: [{ path: path.join(dir, 'src/b.ts'), content: 'b\n' }],
      isShell: false,
      stopHookActive: false,
    });
    expect((await inputFor(dir, 'fs_write', { command: 'str_replace', path: file, old_str: '1', new_str: '2' })).edits).toEqual([{ path: file, content: 'const a = 2;\n' }]);
    expect((await inputFor(dir, 'str_replace', { path: file, oldStr: 'a', newStr: 'z' })).edits).toEqual([{ path: file, content: 'const z = 1;\n' }]);
    expect((await inputFor(dir, 'fs_append', { path: file, new_str: 'x' })).edits).toEqual([{ path: file }]);
    expect((await inputFor(dir, 'delete_file', { path: file })).edits).toEqual([{ path: file, content: null }]);
  });

  it('turns shells and reads into pre-tool', async () => {
    const dir = makeProject({}, false);
    expect(await inputFor(dir, 'execute_bash', { command: 'npm test' })).toMatchObject({ phase: 'pre-tool', isShell: true, edits: [] });
    expect(await inputFor(dir, 'execute_pwsh', { command: 'dir' })).toMatchObject({ phase: 'pre-tool', isShell: true });
    expect(await inputFor(dir, 'read_file', { path: 'a.ts' })).toMatchObject({ phase: 'pre-tool', isShell: false });
  });
});

describe('kiro pre-tool-use answers', () => {
  it('denies with exit code 2, prints context on stdout, and stays quiet when silent', async () => {
    const dir = makeProject({}, false);
    const call = payload(dir, 'fs_write', { command: 'create', path: 'a.ts', file_text: 'x' });
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', call, dir)).toEqual(QUIET);
    core.decision = { kind: 'context', text: 'buckets: 1 pending.' };
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', call, dir)).toEqual({ code: 0, out: 'buckets: 1 pending.\n', err: '' });
    core.decision = { kind: 'deny', text: 'buckets: edit not applied.' };
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', call, dir)).toEqual({ code: 2, out: '', err: 'buckets: edit not applied.\n' });
  });

  it('fails open on a broken payload and on a crash', async () => {
    const dir = makeProject({}, false);
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', '{', dir)).toEqual(QUIET);
    core.fail = true;
    const crashed = await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, 'fs_write', { path: 'a.ts' }), dir);
    expect(crashed).toMatchObject({ code: 0, out: '' });
    expect(crashed.err).toContain('core crashed');
  });
});

describe('kiro stop', () => {
  const stop = (dir: string, session: string) => ({ hook_event_name: 'stop', cwd: dir, session_id: session });

  it('blocks once with decision block, then lets the agent finish', async () => {
    const dir = makeProject({}, false);
    const session = newSessionId();
    core.decision = { kind: 'block', text: 'buckets: 2 structure violations remain.' };
    expect(await runAdapter(kiroAdapter, 'stop', stop(dir, session), dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: 'buckets: 2 structure violations remain.' }), err: '' });
    expect(core.inputs.at(-1)).toMatchObject({ phase: 'stop', sessionId: session, stopHookActive: false, edits: [] });
    expect(await runAdapter(kiroAdapter, 'stop', stop(dir, session), dir)).toEqual(QUIET);
    expect(core.inputs.at(-1)).toMatchObject({ stopHookActive: true });
    expect((await runAdapter(kiroAdapter, 'stop', stop(dir, session), dir)).out).toContain('"decision":"block"');
  });

  it('exits with 0 and prints nothing on a crash, so Kiro never reads it as "continue"', async () => {
    const dir = makeProject({}, false);
    core.fail = true;
    const crashed = await runAdapter(kiroAdapter, 'stop', stop(dir, newSessionId()), dir);
    expect(crashed).toMatchObject({ code: 0, out: '' });
  });
});

describe('kiro install', () => {
  const read = (dir: string, file: string) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;

  it('writes the standalone hook file with PreToolUse and Stop and is idempotent', () => {
    const dir = makeProject({}, false);
    const first = kiroAdapter.install(dir, { skill: null });
    expect(first[0]).toEqual({ status: 'done', text: `Installed the Kiro hooks in ${KIRO_HOOK_FILE} (PreToolUse, Stop, for Kiro CLI 3 and the Kiro IDE)` });
    expect(first.some((s) => s.status === 'todo' && s.text.includes('Kiro CLI 2.x'))).toBe(true);
    expect(first.some((s) => s.status === 'todo' && s.text.includes('buckets init --git-hook'))).toBe(true);
    expect(read(dir, KIRO_HOOK_FILE)).toEqual({ version: 'v1', hooks: KIRO_V1_HOOKS });
    expect(KIRO_V1_HOOKS.map((h) => h.action.command)).toEqual(['buckets hook --agent kiro pre-tool-use', 'buckets hook --agent kiro stop']);
    const text = readFileSync(path.join(dir, KIRO_HOOK_FILE), 'utf8');
    expect(kiroAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
    expect(readFileSync(path.join(dir, KIRO_HOOK_FILE), 'utf8')).toBe(text);
  });

  it('adds the Stop hook to a 1.x hook file', () => {
    const dir = makeProject({ [KIRO_HOOK_FILE]: JSON.stringify({ version: 'v1', hooks: [KIRO_V1_HOOKS[0]] }) }, false);
    expect(kiroAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: `Installed the Kiro hooks in ${KIRO_HOOK_FILE} (Stop, for Kiro CLI 3 and the Kiro IDE)` });
    expect(read(dir, KIRO_HOOK_FILE)).toEqual({ version: 'v1', hooks: KIRO_V1_HOOKS });
  });

  it("merges only preToolUse into each agent config and keeps the user's hooks", () => {
    const agent = { name: 'dev', tools: ['*'], hooks: { agentSpawn: [{ command: 'git status' }], preToolUse: [{ matcher: 'execute_bash', command: './audit.sh' }] } };
    const dir = makeProject({ '.kiro/agents/dev.json': `${JSON.stringify(agent, null, 2)}\n` }, false);
    const steps = kiroAdapter.install(dir, { skill: null });
    expect(steps[1]).toEqual({ status: 'done', text: 'Installed Kiro hooks in .kiro/agents/dev.json (preToolUse)' });
    const dev = read(dir, '.kiro/agents/dev.json') as { hooks: Record<string, unknown> };
    expect(dev.hooks.preToolUse).toEqual([{ matcher: 'execute_bash', command: './audit.sh' }, { command: 'buckets hook --agent kiro pre-tool-use', timeout_ms: 60000 }]);
    expect(dev.hooks.stop).toBeUndefined();
    expect(kiroAdapter.install(dir, { skill: null }).some((s) => s.status === 'done')).toBe(false);
  });

  it('keeps other hooks in its own hook file and refuses a broken one', () => {
    const other = { name: 'fmt', trigger: 'PostFileSave', action: { type: 'command', command: 'prettier --write' } };
    const dir = makeProject({ [KIRO_HOOK_FILE]: JSON.stringify({ version: 'v1', hooks: [other] }) }, false);
    expect(kiroAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    expect(read(dir, KIRO_HOOK_FILE)).toEqual({ version: 'v1', hooks: [other, ...KIRO_V1_HOOKS] });

    const broken = makeProject({ [KIRO_HOOK_FILE]: '[1]' }, false);
    expect(kiroAdapter.install(broken, { skill: null })[0]).toMatchObject({ status: 'failed' });
    expect(readFileSync(path.join(broken, KIRO_HOOK_FILE), 'utf8')).toBe('[1]');
  });
});

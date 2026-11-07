// The Crush adapter with Crush payloads: one PreToolUse hook for every tool, context or deny as JSON, never allow.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookDecision, HookInput } from '../../contract/hooks.js';
import { parseJson } from '../../files/json.js';
import { cleanupProjects, fileExists, makeProject, readFile, writeFile } from '../../testing/fixture.js';
import { installSuite, line, runAdapter } from './adapter-test-kit.js';
import { crushAdapter, crushRcLine, crushTarget } from './crush.js';

const core = vi.hoisted(() => ({ decision: { kind: 'silent' } as HookDecision, inputs: [] as HookInput[], fail: false }));
vi.mock('../core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core.js')>()),
  hookCore: async (input: HookInput) => {
    core.inputs.push(input);
    if (core.fail) throw new Error('core crashed');
    return core.decision;
  },
}));

beforeEach(() => {
  core.decision = { kind: 'silent' };
  core.inputs = [];
  core.fail = false;
});
afterEach(cleanupProjects);

function payload(dir: string, tool: string, input: Record<string, unknown>) {
  return { event: 'PreToolUse', session_id: '313909e', cwd: dir, tool_name: tool, tool_input: input };
}

async function inputFor(dir: string, tool: string, args: Record<string, unknown>, env: Record<string, string> = {}): Promise<HookInput> {
  await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, tool, args), dir, env);
  return core.inputs.at(-1)!;
}

describe('crush payloads', () => {
  it('turns the file tools into pre-edit with the new text', async () => {
    const dir = makeProject({ 'src/a.ts': 'const a = 1;\nconst b = 1;\n' }, false);
    const file = path.join(dir, 'src/a.ts');
    expect(await inputFor(dir, 'write', { file_path: 'src/new.ts', content: 'x\n' })).toEqual({
      phase: 'pre-edit',
      sessionId: '313909e',
      agentId: null,
      cwd: dir,
      root: dir,
      toolName: 'write',
      edits: [{ path: path.join(dir, 'src/new.ts'), content: 'x\n' }],
      isShell: false,
      stopHookActive: false,
    });
    expect((await inputFor(dir, 'edit', { file_path: file, old_string: '= 1', new_string: '= 2', replace_all: true })).edits).toEqual([{ path: file, content: 'const a = 2;\nconst b = 2;\n' }]);
    expect((await inputFor(dir, 'edit', { file_path: file, old_string: '= 1', new_string: '= $&2' })).edits).toEqual([{ path: file, content: 'const a = $&2;\nconst b = 1;\n' }]);
    const multi = { file_path: file, edits: [{ old_string: 'a', new_string: 'x' }, { old_string: 'b', new_string: 'y' }] };
    expect((await inputFor(dir, 'multiedit', multi)).edits).toEqual([{ path: file, content: 'const x = 1;\nconst y = 1;\n' }]);
  });

  it('sends an edit without its text when the input does not give it', async () => {
    const dir = makeProject({ 'src/a.ts': 'a\n' }, false);
    const file = path.join(dir, 'src/a.ts');
    expect((await inputFor(dir, 'edit', { file_path: file, old_string: 'missing', new_string: 'x' })).edits).toEqual([{ path: file }]);
    expect((await inputFor(dir, 'download', { url: 'https://x', file_path: file })).edits).toEqual([{ path: file }]);
    expect((await inputFor(dir, 'lsp_replace_symbol', { file_path: file, symbol: 'a' })).edits).toEqual([{ path: file }]);
  });

  it('turns shell and other tools into pre-tool, and reads the project folder from CRUSH_PROJECT_DIR', async () => {
    const dir = makeProject({}, false);
    const shell = await inputFor(dir, 'bash', { command: 'npm test' }, { CRUSH_PROJECT_DIR: path.dirname(dir) });
    expect(shell).toMatchObject({ phase: 'pre-tool', isShell: true, edits: [], cwd: dir, root: path.dirname(dir), toolName: 'bash' });
    expect(await inputFor(dir, 'view', { file_path: 'a.ts' })).toMatchObject({ phase: 'pre-tool', isShell: false });
    expect(await inputFor(dir, 'lsp_rename', { symbol: 'a', new_name: 'b' })).toMatchObject({ phase: 'pre-tool', edits: [] });
  });
});

describe('crush answers', () => {
  const run = async () => runAdapter(crushAdapter, 'pre-tool-use', payload(makeProject({}, false), 'write', { file_path: 'a.ts', content: 'x' }), makeProject({}, false));

  it('prints context alone, deny as a decision, and nothing when silent; never allow', async () => {
    expect(await run()).toEqual({ code: 0, out: '', err: '' });
    core.decision = { kind: 'context', text: 'buckets: 1 pending.' };
    expect(await run()).toEqual({ code: 0, out: line({ context: 'buckets: 1 pending.' }), err: '' });
    core.decision = { kind: 'deny', text: 'buckets: edit not applied.' };
    expect(await run()).toEqual({ code: 0, out: line({ decision: 'deny', reason: 'buckets: edit not applied.' }), err: '' });
  });

  it('fails open on a broken payload and on a crash', async () => {
    const dir = makeProject({}, false);
    expect(await runAdapter(crushAdapter, 'pre-tool-use', 'not json', dir)).toEqual({ code: 0, out: '', err: '' });
    expect(core.inputs.at(-1)).toMatchObject({ phase: 'pre-tool', sessionId: null });
    core.fail = true;
    const crashed = await run();
    expect(crashed.code).toBe(0);
    expect(crashed.out).toBe('');
    expect(crashed.err).toContain('core crashed');
  });
});

describe('crush install', () => {
  installSuite(crushAdapter, {
    file: '.crush.json',
    userText: '{\n  "$schema": "https://charm.land/crush.json",\n  "hooks": {\n    // no rm -rf\n    "PreToolUse": [{ "matcher": "^bash$", "command": "./hooks/no-rm-rf.sh" }]\n  }\n}\n',
    fresh(json) {
      expect((json.hooks as Record<string, unknown[]>).PreToolUse).toEqual([{ name: 'slopbuckets', command: 'buckets hook --agent crush pre-tool-use', timeout: 60 }]);
    },
  });

  it('says that Crush relies on AGENTS.md and the git hook', () => {
    const steps = crushAdapter.install(makeProject({}, false), { skill: null });
    expect(steps.at(-1)).toMatchObject({ status: 'todo', text: expect.stringContaining('buckets init --git-hook') });
  });

  it('drops an older matcher, so the hook sees every tool', () => {
    const old = { hooks: { PreToolUse: [{ name: 'slopbuckets', matcher: '^(bash|edit|multiedit|write|download)$', command: 'buckets hook --agent crush pre-tool-use', timeout: 60 }] } };
    const dir = makeProject({ '.crush.json': JSON.stringify(old) }, false);
    expect(crushAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: 'Updated the Crush hooks in .crush.json (PreToolUse)' });
    expect(parseJson(readFile(dir, '.crush.json'))).toEqual({ hooks: { PreToolUse: [{ name: 'slopbuckets', command: 'buckets hook --agent crush pre-tool-use', timeout: 60 }] } });
  });

  it('merges into an existing crush.json instead of adding .crush.json', () => {
    const dir = makeProject({ 'crush.json': '{ "options": { "debug": true } }\n' }, false);
    expect(crushTarget(dir)).toBe('crush.json');
    expect(crushAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done', text: expect.stringContaining('crush.json') });
    expect(parseJson(readFile(dir, 'crush.json'))).toMatchObject({ options: { debug: true } });
    expect(fileExists(dir, '.crush.json')).toBe(false);
  });

  it('writes to a crushrc when the project has one', () => {
    const json = { options: { debug: true }, hooks: { PreToolUse: [{ name: 'slopbuckets', matcher: '^bash$', command: 'buckets hook --agent crush pre-tool-use' }] } };
    const dir = makeProject({ '.crushrc': 'set -e\r\nhook add PreToolUse --name lint --command ./lint.sh\r\n', 'crush.json': JSON.stringify(json) }, false);
    expect(crushTarget(dir)).toBe('.crushrc');
    const steps = crushAdapter.install(dir, { skill: null });
    expect(steps[0]).toEqual({ status: 'done', text: 'Installed Crush hooks in .crushrc (PreToolUse)' });
    expect(readFile(dir, '.crushrc')).toBe(`set -e\r\nhook add PreToolUse --name lint --command ./lint.sh\r\n${crushRcLine()}\r\n`);
    expect(crushAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'kept', text: 'Crush hooks are already in .crushrc' });
  });

  it('writes its line into an empty crushrc', () => {
    const dir = makeProject({}, false);
    writeFile(dir, 'crushrc', '');
    expect(crushAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    expect(readFile(dir, 'crushrc')).toBe(`${crushRcLine()}\n`);
  });
});

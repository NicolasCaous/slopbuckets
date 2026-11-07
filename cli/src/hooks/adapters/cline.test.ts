// The Cline adapter with Cline payloads: the CLI 3.x tool_call block and the legacy stringified preToolUse block,
// context through contextModification, and a cancel only for the config-invalid deny.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookDecision, HookInput } from '../../contract/hooks.js';
import { renderInterrupt } from '../../contract/messages.js';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { SAMPLES } from '../../testing/samples.js';
import { line, patch, runAdapter } from './adapter-test-kit.js';
import { clineAdapter, clineParameters, powershellScript, unixScript } from './cline.js';

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

const NEUTRAL = line({ cancel: false });

/** Cline turns every parameter value that is not a string into a JSON string. */
function stringify(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
}

/** The VS Code payload: only the legacy block. */
function legacy(dir: string, toolName: string, params: Record<string, unknown>) {
  return { clineVersion: '4.2.0', hookName: 'PreToolUse', timestamp: '1759590000000', taskId: 'task-1', workspaceRoots: [dir], userId: 'u', preToolUse: { toolName, parameters: stringify(params) } };
}

/** The CLI 3.x payload: tool_call with objects, next to the legacy block. */
function sdk(dir: string, name: string, input: Record<string, unknown>, agent: { agent_id: string; parent_agent_id: string | null } = { agent_id: 'a1', parent_agent_id: null }) {
  return { ...legacy(dir, name, input), hookName: 'tool_call', sessionContext: { rootSessionId: 'root-1' }, ...agent, tool_call: { id: 'c1', name, input } };
}

async function inputFor(dir: string, body: unknown): Promise<HookInput> {
  await runAdapter(clineAdapter, 'pre-tool-use', body, dir);
  return core.inputs.at(-1)!;
}

describe('cline payloads', () => {
  it('turns editor calls into pre-edit with the new text, from either block', async () => {
    const dir = makeProject({ 'src/a.ts': 'const a = 1;\n' }, false);
    const file = path.join(dir, 'src/a.ts');
    expect(await inputFor(dir, legacy(dir, 'editor', { path: file, old_text: '1', new_text: '2' }))).toEqual({
      phase: 'pre-edit',
      sessionId: 'task-1',
      agentId: null,
      cwd: dir,
      root: dir,
      toolName: 'editor',
      edits: [{ path: file, content: 'const a = 2;\n' }],
      isShell: false,
      stopHookActive: false,
    });
    expect((await inputFor(dir, sdk(dir, 'editor', { path: 'src/b.ts', new_text: 'b\n' }))).edits).toEqual([{ path: path.join(dir, 'src/b.ts'), content: 'b\n' }]);
    expect((await inputFor(dir, sdk(dir, 'editor', { path: file, new_text: 'x', insert_line: 3 }))).edits).toEqual([{ path: file }]);
    expect((await inputFor(dir, legacy(dir, 'write_to_file', { path: file, content: 'all\n' }))).edits).toEqual([{ path: file, content: 'all\n' }]);
  });

  it('reads apply_patch: added files with text, deleted files as null, updated files with the hunks applied', async () => {
    const dir = makeProject({ 'src/a.ts': 'a\n' }, false);
    const text = patch(['*** Add File: src/new.ts', '+export const n = 1;', '+', '*** Delete File: src/old.ts', '*** Update File: src/a.ts', '@@', '-a', '+b'], true);
    expect((await inputFor(dir, sdk(dir, 'apply_patch', { input: text }))).edits).toEqual([
      { path: path.join(dir, 'src/new.ts'), content: 'export const n = 1;\n\n' },
      { path: path.join(dir, 'src/old.ts'), content: null },
      { path: path.join(dir, 'src/a.ts'), content: 'b\n' },
    ]);
  });

  it('turns commands and reads into pre-tool, and gives a subagent its own id', async () => {
    const dir = makeProject({}, false);
    expect(await inputFor(dir, legacy(dir, 'run_commands', { commands: ['npm test'] }))).toMatchObject({ phase: 'pre-tool', isShell: true, edits: [] });
    expect(await inputFor(dir, sdk(dir, 'read_files', { files: [{ path: 'a.ts' }] }))).toMatchObject({ phase: 'pre-tool', isShell: false, edits: [] });
    expect(await inputFor(dir, sdk(dir, 'read_files', {}, { agent_id: 'sub-7', parent_agent_id: 'a1' }))).toMatchObject({ sessionId: 'task-1', agentId: 'sub-7' });
    const noTask = { ...sdk(dir, 'read_files', {}), taskId: undefined };
    expect(await inputFor(dir, noTask)).toMatchObject({ sessionId: 'root-1', agentId: null });
  });

  it('decodes stringified values', () => {
    expect(clineParameters({ parameters: { commands: '["npm test","buckets check"]', path: '/a/b.ts' } })).toEqual({ commands: ['npm test', 'buckets check'], path: '/a/b.ts' });
    expect(clineParameters({ parameters: '{"path":"x"}' })).toEqual({ path: 'x' });
    expect(clineParameters({ parameters: { note: '[not json' } })).toEqual({ note: '[not json' });
  });
});

describe('cline answers', () => {
  const run = async () => {
    const dir = makeProject({}, false);
    return runAdapter(clineAdapter, 'pre-tool-use', legacy(dir, 'write_to_file', { path: 'a.ts', content: 'x' }), dir);
  };

  it('answers cancel: false with the context, and cancels only on deny', async () => {
    expect(await run()).toEqual({ code: 0, out: NEUTRAL, err: '' });
    core.decision = { kind: 'context', text: 'buckets: 1 pending.' };
    expect(await run()).toEqual({ code: 0, out: line({ cancel: false, contextModification: 'buckets: 1 pending.' }), err: '' });
    const interrupt = renderInterrupt([SAMPLES['config-invalid']] as never);
    core.decision = { kind: 'deny', text: interrupt };
    expect(await run()).toEqual({ code: 0, out: line({ cancel: true, errorMessage: interrupt }), err: '' });
  });

  it('cuts a long context at the Cline limit', async () => {
    core.decision = { kind: 'context', text: 'x'.repeat(60_000) };
    const out = JSON.parse((await run()).out) as { contextModification: string };
    expect(out.contextModification.length).toBeLessThan(50_000);
    expect(out.contextModification).toContain('buckets check');
  });

  it('fails open on a broken payload and on a crash', async () => {
    const dir = makeProject({}, false);
    expect(await runAdapter(clineAdapter, 'pre-tool-use', 'not json', dir)).toEqual({ code: 0, out: NEUTRAL, err: '' });
    core.fail = true;
    const crashed = await run();
    expect(crashed).toMatchObject({ code: 0, out: NEUTRAL });
    expect(crashed.err).toContain('core crashed');
  });
});

describe('cline install', () => {
  const files = ['PreToolUse', 'PreToolUse.ps1'].map((f) => `.clinerules/hooks/${f}`);

  it('writes one script per platform, idempotently', () => {
    const dir = makeProject({}, false);
    const first = clineAdapter.install(dir, { skill: null });
    expect(first[0]).toEqual({ status: 'done', text: 'Installed the Cline hooks in .clinerules/hooks/ (PreToolUse, PreToolUse.ps1)' });
    expect(first.some((s) => s.status === 'todo' && s.text.includes('Enable Hooks'))).toBe(true);
    expect(first.at(-1)).toMatchObject({ status: 'todo', text: expect.stringContaining('buckets init --git-hook') });
    for (const file of files) expect(existsSync(path.join(dir, file))).toBe(true);
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PreToolUse'), 'utf8')).toBe(unixScript('pre-tool-use'));
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PreToolUse.ps1'), 'utf8')).toBe(powershellScript('pre-tool-use'));
    expect(unixScript('pre-tool-use')).toContain('exec buckets hook --agent cline pre-tool-use');
    if (process.platform !== 'win32') expect(statSync(path.join(dir, '.clinerules/hooks/PreToolUse')).mode & 0o111).not.toBe(0);

    expect(clineAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'kept', text: 'The Cline hooks in .clinerules/hooks/ are up to date' });
  });

  it("leaves the user's own hook scripts and rules alone", () => {
    const mine = '#!/bin/sh\necho \'{"cancel":false}\'\n';
    const dir = makeProject({ '.clinerules/hooks/PreToolUse': mine, '.clinerules/hooks/PostToolUse': mine, '.clinerules/style.md': '# style\n' }, false);
    const steps = clineAdapter.install(dir, { skill: null });
    expect(steps.some((s) => s.status === 'todo' && s.text.includes('.clinerules/hooks/PreToolUse is your own hook'))).toBe(true);
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PreToolUse'), 'utf8')).toBe(mine);
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PreToolUse'), 'utf8')).toBe(mine);
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PostToolUse'), 'utf8')).toBe(mine);
    expect(existsSync(path.join(dir, '.clinerules/style.md'))).toBe(true);
  });

  it('updates an outdated slopbuckets script', () => {
    const dir = makeProject({}, false);
    clineAdapter.install(dir, { skill: null });
    const file = path.join(dir, '.clinerules/hooks/PreToolUse');
    writeFileSync(file, readFileSync(file, 'utf8').replace('exec buckets', 'exec old-buckets'), 'utf8');
    expect(clineAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: 'Installed the Cline hooks in .clinerules/hooks/ (PreToolUse)' });
    expect(readFileSync(file, 'utf8')).toBe(unixScript('pre-tool-use'));
  });

  it('does not touch a .clinerules rules file', () => {
    const dir = makeProject({}, false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.clinerules'), 'Use tabs.\n', 'utf8');
    expect(clineAdapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'todo' })]);
    expect(readFileSync(path.join(dir, '.clinerules'), 'utf8')).toBe('Use tabs.\n');
  });
});

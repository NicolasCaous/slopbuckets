// The Devin adapter with Devin payloads: PreToolUse denies only with exit 2, PostToolUse carries the pending list (the
// post-tool fallback), Stop blocks once, PostCompact. Install writes hooks.v1.json without a "hooks" wrapper.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { normalizeHarnessPath } from '../input.js';
import { installSuite, line, patch, runAdapter } from './adapter-test-kit.js';
import { devinAdapter } from './devin.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(event: string, extra: Record<string, unknown>) {
  return { hook_event_name: event, session_id: 'dv-1', prompt_id: 'p-1', ...extra };
}

const pre = (tool: string, input: Record<string, unknown>) => payload('PreToolUse', { tool_name: tool, tool_input: input, tool_provenance: 'builtin' });
const post = (tool: string, input: Record<string, unknown>) => payload('PostToolUse', { tool_name: tool, tool_input: input, tool_output: 'ok' });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('devin phases', () => {
  it('PreToolUse simulates write, edit and apply_patch without a session', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(devinAdapter, 'pre-tool-use', pre('write', { file_path: 'src/b.ts', content: 'b' }), dir);
    await runAdapter(devinAdapter, 'pre-tool-use', pre('edit', { file_path: 'src/a.ts', old_string: '1', new_string: '2' }), dir);
    await runAdapter(devinAdapter, 'pre-tool-use', pre('apply_patch', { patch: patch(['*** Delete File: src/a.ts']) }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.edits])).toEqual([
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'b.ts'), content: 'b' }]],
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 2;\n' }]],
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'a.ts'), content: null }]],
    ]);
  });

  it('PostToolUse runs a pre-edit of the files on disk, or a pre-tool, with DEVIN_PROJECT_DIR as root', async () => {
    const dir = project();
    const calls = fakeCore();
    const env = { DEVIN_PROJECT_DIR: dir };
    await runAdapter(devinAdapter, 'post-tool-use', post('edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }), dir, env);
    await runAdapter(devinAdapter, 'post-tool-use', post('exec', { command: 'npm test', shell_id: 'main' }), dir, env);
    await runAdapter(devinAdapter, 'post-tool-use', post('read', { file_path: 'src/a.ts' }), dir, env);
    expect(calls.map((c) => [c.phase, c.sessionId, c.root, c.edits, c.isShell])).toEqual([
      ['pre-edit', 'dv-1', normalizeHarnessPath(dir), [{ path: path.join(normalizeHarnessPath(dir), 'src', 'a.ts'), content: 'export const a = 1;\n' }], false],
      ['pre-tool', 'dv-1', normalizeHarnessPath(dir), [], true],
      ['pre-tool', 'dv-1', normalizeHarnessPath(dir), [], false],
    ]);
  });

  it('maps Stop with stop_hook_active, and PostCompact', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(devinAdapter, 'stop', payload('Stop', { stop_hook_active: true, last_assistant_message: 'done' }), dir);
    await runAdapter(devinAdapter, 'post-compact', payload('PostCompact', { trigger: 'auto' }), dir);
    expect(calls.map((c) => [c.phase, c.stopHookActive])).toEqual([
      ['stop', true],
      ['post-compact', false],
    ]);
  });
});

describe('devin answers', () => {
  decisionCases(devinAdapter, 'pre-tool-use', () => pre('write', { file_path: 'src/c.ts', content: 'c' }), project, { deny: { code: 2, out: '', err: `${TEXT}\n` } });
  const context = line({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: TEXT } });
  decisionCases(devinAdapter, 'post-tool-use', () => post('write', { file_path: 'src/a.ts' }), project, { context: { code: 0, out: context } });
  decisionCases(devinAdapter, 'post-tool-use', () => post('exec', { command: 'ls' }), project, { context: { code: 0, out: context } });
  decisionCases(devinAdapter, 'stop', () => payload('Stop', { stop_hook_active: false }), project, { block: { code: 0, out: line({ decision: 'block', reason: TEXT }) } });
  decisionCases(devinAdapter, 'post-compact', () => payload('PostCompact', { trigger: 'manual' }), project, {});
});

describe('devin fails open', () => {
  it('exits with 0 and prints nothing when the core crashes', async () => {
    const dir = project();
    crashingCore();
    for (const event of devinAdapter.events) {
      expect(await runAdapter(devinAdapter, event, pre('write', { file_path: 'x.ts', content: '' }), dir)).toMatchObject({ code: 0, out: '' });
    }
  });
});

describe('devin install', () => {
  installSuite(devinAdapter, {
    file: '.devin/hooks.v1.json',
    userText: JSON.stringify({ PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: './guard.sh' }] }] }, null, 2),
    fresh(json) {
      expect(json).toEqual({
        PreToolUse: [{ matcher: '^(write|edit|apply_patch|notebook_edit)$', hooks: [{ type: 'command', command: 'buckets hook --agent devin pre-tool-use', timeout: 60 }] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'buckets hook --agent devin post-tool-use', timeout: 60 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent devin stop', timeout: 600 }] }],
        PostCompact: [{ hooks: [{ type: 'command', command: 'buckets hook --agent devin post-compact', timeout: 30 }] }],
      });
    },
  });
});

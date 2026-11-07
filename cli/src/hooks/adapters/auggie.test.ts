// The Auggie adapter with Auggie payloads: PreToolUse denies only, PostToolUse carries the pending list with the new
// text from file_changes (the post-tool fallback), Stop blocks once by mark on end_turn. Install writes one command per
// event, the same on every system.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { normalizeHarnessPath } from '../input.js';
import { line, newSessionId, runAdapter } from './adapter-test-kit.js';
import { auggieAdapter } from './auggie.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(dir: string, event: string, extra: Record<string, unknown>, conversation = 'au-1') {
  return { hook_event_name: event, conversation_id: conversation, workspace_roots: [dir], ...extra };
}

const pre = (dir: string, tool: string, input: Record<string, unknown>) => payload(dir, 'PreToolUse', { tool_name: tool, tool_input: input, is_mcp_tool: false });
const post = (dir: string, tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  payload(dir, 'PostToolUse', { tool_name: tool, tool_input: input, is_mcp_tool: false, tool_output: 'ok', tool_error: null, ...extra });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('auggie phases', () => {
  it('PreToolUse simulates str-replace-editor with numbered pairs and remove-files, without a session', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(auggieAdapter, 'pre-tool-use', pre(dir, 'str-replace-editor', { command: 'str_replace', path: 'src/a.ts', old_str_1: '1', new_str_1: '2' }), dir);
    await runAdapter(auggieAdapter, 'pre-tool-use', pre(dir, 'remove-files', { file_paths: ['src/a.ts'] }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.edits])).toEqual([
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 2;\n' }]],
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'a.ts'), content: null }]],
    ]);
  });

  it('PostToolUse takes the new text from file_changes, else the disk, and the root from AUGMENT_PROJECT_DIR', async () => {
    const dir = project();
    const calls = fakeCore();
    const changes = [{ path: 'src/a.ts', changeType: 'edit', content: 'export const a = 9;\n', oldContent: 'export const a = 1;\n' }, { path: 'src/old.ts', changeType: 'delete' }];
    await runAdapter(auggieAdapter, 'post-tool-use', post(dir, 'save-file', { path: 'src/a.ts' }, { file_changes: changes }), dir, { AUGMENT_PROJECT_DIR: dir });
    await runAdapter(auggieAdapter, 'post-tool-use', post(dir, 'save-file', { path: 'src/a.ts' }), dir);
    await runAdapter(auggieAdapter, 'post-tool-use', post(dir, 'launch-process', { command: 'npm test' }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.root, c.edits, c.isShell])).toEqual([
      [
        'pre-edit',
        'au-1',
        normalizeHarnessPath(dir),
        [
          { path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 9;\n' },
          { path: path.join(dir, 'src', 'old.ts'), content: null },
        ],
        false,
      ],
      ['pre-edit', 'au-1', normalizeHarnessPath(dir), [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 1;\n' }], false],
      ['pre-tool', 'au-1', normalizeHarnessPath(dir), [], true],
    ]);
  });

  it('Stop checks only an end_turn, and blocks once per conversation by mark', async () => {
    const dir = project();
    const calls = fakeCore((input) => (input.stopHookActive ? { kind: 'silent' } : { kind: 'block', text: TEXT }));
    const conversation = newSessionId();
    const stop = (cause: string) => payload(dir, 'Stop', { agent_stop_cause: cause }, conversation);
    expect((await runAdapter(auggieAdapter, 'stop', stop('interrupted'), dir)).out).toBe('');
    expect((await runAdapter(auggieAdapter, 'stop', stop('end_turn'), dir)).out).not.toBe('');
    expect((await runAdapter(auggieAdapter, 'stop', stop('end_turn'), dir)).out).toBe('');
    expect(calls.map((c) => [c.phase, c.stopHookActive])).toEqual([
      ['stop', false],
      ['stop', true],
    ]);
  });
});

describe('auggie answers', () => {
  decisionCases(auggieAdapter, 'pre-tool-use', (dir) => pre(dir, 'save-file', { path: 'src/c.ts', file_content: 'c' }), project, {
    deny: { code: 0, out: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: TEXT } }) },
  });
  const context = line({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: TEXT } });
  decisionCases(auggieAdapter, 'post-tool-use', (dir) => post(dir, 'save-file', { path: 'src/a.ts' }), project, { context: { code: 0, out: context } });
  decisionCases(auggieAdapter, 'post-tool-use', (dir) => post(dir, 'view', { path: 'src/a.ts' }), project, { context: { code: 0, out: context } });
  decisionCases(auggieAdapter, 'stop', (dir) => payload(dir, 'Stop', { agent_stop_cause: 'end_turn' }, newSessionId()), project, {
    block: { code: 0, out: line({ decision: 'block', reason: TEXT, hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason: TEXT } }) },
  });
});

describe('auggie fails open', () => {
  it('exits with 0 and prints nothing when the core crashes', async () => {
    const dir = project();
    crashingCore();
    for (const event of auggieAdapter.events) {
      expect(await runAdapter(auggieAdapter, event, pre(dir, 'save-file', { path: 'x.ts', file_content: '' }), dir)).toMatchObject({ code: 0, out: '' });
    }
  });

});

describe('auggie install', () => {
  const fresh = {
    hooks: {
      PreToolUse: [{ matcher: 'save-file|str-replace-editor|remove-files', hooks: [{ type: 'command', command: 'buckets hook --agent auggie pre-tool-use || exit 0', timeout: 60000 }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'buckets hook --agent auggie post-tool-use || exit 0', timeout: 60000 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent auggie stop || exit 0', timeout: 600000 }] }],
    },
  };

  it('writes the same settings on every system and runs a second time without changes', () => {
    const dir = makeProject({}, false);
    expect(auggieAdapter.install(dir, { skill: null })).toEqual([{ status: 'done', text: 'Installed Auggie hooks in .augment/settings.json (PreToolUse, PostToolUse, Stop)' }]);
    const text = readFile(dir, '.augment/settings.json');
    expect(JSON.parse(text)).toEqual(fresh);
    expect(auggieAdapter.install(dir, { skill: null })).toEqual([{ status: 'kept', text: 'Auggie hooks are already in .augment/settings.json' }]);
    expect(readFile(dir, '.augment/settings.json')).toBe(text);
  });

  it('replaces the 1.x entries, which ran the bare hook command', () => {
    const v1 = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent auggie stop' }] }] } };
    const dir = makeProject({ '.augment/settings.json': JSON.stringify(v1) }, false);
    expect(auggieAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done', text: expect.stringContaining('Updated the Auggie hooks') });
    expect(JSON.parse(readFile(dir, '.augment/settings.json'))).toEqual(fresh);
  });

  it("keeps the user's settings and hooks", () => {
    const user = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: './mine.sh' }] }] } };
    const dir = makeProject({ '.augment/settings.json': JSON.stringify(user, null, 2) }, false);
    auggieAdapter.install(dir, { skill: null });
    const after = JSON.parse(readFile(dir, '.augment/settings.json'));
    expect(after.model).toBe('x');
    expect(after.hooks.Stop).toEqual([user.hooks.Stop[0], fresh.hooks.Stop[0]]);
  });

  it('refuses a config it cannot merge into', () => {
    const dir = makeProject({ '.augment/settings.json': '[1]\n' }, false);
    expect(auggieAdapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(readFileSync(path.join(dir, '.augment/settings.json'), 'utf8')).toBe('[1]\n');
  });
});

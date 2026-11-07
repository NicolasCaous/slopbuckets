// The Factory Droid adapter with Droid payloads: PreToolUse denies only, PostToolUse carries the pending list (the
// post-tool fallback), Stop and SubagentStop block once, SessionStart with source compact is the post-compact.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { normalizeHarnessPath } from '../input.js';
import { installSuite, line, patch, runAdapter } from './adapter-test-kit.js';
import { factoryAdapter } from './factory.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return { session_id: 'f-1', transcript_path: path.join(dir, 't.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: event, ...extra };
}

const pre = (dir: string, tool: string, input: Record<string, unknown>) => payload(dir, 'PreToolUse', { tool_name: tool, tool_input: input });
const post = (dir: string, tool: string, input: Record<string, unknown>) => payload(dir, 'PostToolUse', { tool_name: tool, tool_input: input, tool_response: { success: true } });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('factory phases', () => {
  it('PreToolUse simulates Create and ApplyPatch without a session, and skips Execute', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(factoryAdapter, 'pre-tool-use', pre(dir, 'Create', { file_path: path.join(dir, 'src/b.ts'), content: 'b' }), dir);
    await runAdapter(factoryAdapter, 'pre-tool-use', pre(dir, 'ApplyPatch', { patch: patch(['*** Update File: src/a.ts', '@@', '-export const a = 1;', '+export const a = 3;']) }), dir);
    await runAdapter(factoryAdapter, 'pre-tool-use', pre(dir, 'Execute', { command: 'ls' }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.edits])).toEqual([
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'b.ts'), content: 'b' }]],
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 3;\n' }]],
    ]);
  });

  it('PostToolUse runs a pre-edit of the files on disk, or a pre-tool, with FACTORY_PROJECT_DIR as root', async () => {
    const dir = project();
    const calls = fakeCore();
    const env = { FACTORY_PROJECT_DIR: dir };
    await runAdapter(factoryAdapter, 'post-tool-use', post(dir, 'Edit', { file_path: path.join(dir, 'src/a.ts'), old_str: 'x', new_str: 'y' }), dir, env);
    await runAdapter(factoryAdapter, 'post-tool-use', post(dir, 'Execute', { command: 'npm test' }), dir, env);
    expect(calls.map((c) => [c.phase, c.sessionId, c.root, c.edits, c.isShell])).toEqual([
      ['pre-edit', 'f-1', normalizeHarnessPath(dir), [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 1;\n' }], false],
      ['pre-tool', 'f-1', normalizeHarnessPath(dir), [], true],
    ]);
  });

  it('maps Stop and SubagentStop with stop_hook_active, and SessionStart compact to post-compact', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(factoryAdapter, 'stop', payload(dir, 'Stop', { stop_hook_active: false, tool_execution_count: 3, elapsed_time: 10 }), dir);
    await runAdapter(factoryAdapter, 'subagent-stop', payload(dir, 'SubagentStop', { task_name: 'scan', task_result: 'ok', task_error: null, stop_hook_active: true }), dir);
    await runAdapter(factoryAdapter, 'post-compact', payload(dir, 'SessionStart', { source: 'compact' }), dir);
    await runAdapter(factoryAdapter, 'post-compact', payload(dir, 'SessionStart', { source: 'startup' }), dir);
    expect(calls.map((c) => [c.phase, c.stopHookActive])).toEqual([
      ['stop', false],
      ['subagent-stop', true],
      ['post-compact', false],
    ]);
  });
});

describe('factory answers', () => {
  decisionCases(factoryAdapter, 'pre-tool-use', (dir) => pre(dir, 'Create', { file_path: 'src/c.ts', content: 'c' }), project, {
    deny: { code: 0, out: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: TEXT } }) },
  });
  const context = line({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: TEXT } });
  decisionCases(factoryAdapter, 'post-tool-use', (dir) => post(dir, 'Create', { file_path: 'src/a.ts' }), project, { context: { code: 0, out: context } });
  decisionCases(factoryAdapter, 'post-tool-use', (dir) => post(dir, 'Read', { file_path: 'src/a.ts' }), project, { context: { code: 0, out: context } });
  const block = line({ decision: 'block', reason: TEXT });
  decisionCases(factoryAdapter, 'stop', (dir) => payload(dir, 'Stop', { stop_hook_active: false }), project, { block: { code: 0, out: block } });
  decisionCases(factoryAdapter, 'subagent-stop', (dir) => payload(dir, 'SubagentStop', { stop_hook_active: false }), project, { block: { code: 0, out: block } });
  decisionCases(factoryAdapter, 'post-compact', (dir) => payload(dir, 'SessionStart', { source: 'compact' }), project, {});
});

describe('factory fails open', () => {
  it('exits with 0 and prints nothing when the core crashes', async () => {
    const dir = project();
    crashingCore();
    for (const event of factoryAdapter.events) {
      expect(await runAdapter(factoryAdapter, event, pre(dir, 'Create', { file_path: 'x.ts', content: '' }), dir)).toMatchObject({ code: 0, out: '' });
    }
  });
});

describe('factory install', () => {
  installSuite(factoryAdapter, {
    file: '.factory/hooks.json',
    userText: JSON.stringify({ PreToolUse: [{ matcher: 'Execute', hooks: [{ type: 'command', command: './guard.sh' }] }] }, null, 2),
    fresh(json) {
      expect(json).toEqual({
        PreToolUse: [{ matcher: 'Create|Edit|ApplyPatch', hooks: [{ type: 'command', command: 'buckets hook --agent factory pre-tool-use', timeout: 60 }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'buckets hook --agent factory post-tool-use', timeout: 60 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent factory stop', timeout: 600 }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent factory subagent-stop', timeout: 600 }] }],
        SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'buckets hook --agent factory post-compact', timeout: 30 }] }],
      });
    },
  });

  it('migrates a 1.x install: drops MultiEdit and Execute from the matchers, sets timeouts', () => {
    const v1 = {
      PreToolUse: [{ matcher: 'Execute|Create|Edit|MultiEdit|ApplyPatch', hooks: [{ type: 'command', command: 'buckets hook --agent factory pre-tool-use' }] }],
      PostToolUse: [{ matcher: 'Create|Edit|MultiEdit|ApplyPatch', hooks: [{ type: 'command', command: 'buckets hook --agent factory post-tool-use' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent factory stop' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent factory subagent-stop' }] }],
    };
    const dir = makeProject({ '.factory/hooks.json': JSON.stringify(v1, null, 2) }, false);
    expect(factoryAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    const text = readFile(dir, '.factory/hooks.json');
    expect(text).not.toContain('MultiEdit');
    expect(JSON.parse(text).SessionStart).toHaveLength(1);
    expect(factoryAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });
});

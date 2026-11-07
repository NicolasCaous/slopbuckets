// The Cursor adapter with Cursor payloads: preToolUse denies only and otherwise answers {}, postToolUse carries the
// pending list (the post-tool fallback), stop and subagentStop block once by loop_count.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { normalizeHarnessPath } from '../input.js';
import { installSuite, line, runAdapter } from './adapter-test-kit.js';
import { cursorAdapter } from './cursor.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

const NEUTRAL = line({});

/** Cursor writes a Windows workspace root as /c:/Users/...; the adapter must undo that. */
function root(dir: string): string {
  return /^[A-Za-z]:/.test(dir) ? `/${dir.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`)}` : dir;
}

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return {
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    model: 'claude-4.5-sonnet',
    hook_event_name: event,
    cursor_version: '3.21.16',
    workspace_roots: [root(dir)],
    user_email: null,
    transcript_path: null,
    ...extra,
  };
}

const pre = (dir: string, tool: string, input: Record<string, unknown>) => payload(dir, 'preToolUse', { tool_name: tool, tool_input: input, tool_use_id: 'tool_1', cwd: dir });
const post = (dir: string, tool: string, input: Record<string, unknown>) => payload(dir, 'postToolUse', { tool_name: tool, tool_input: input, tool_output: 'ok', tool_use_id: 'tool_1', cwd: dir });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('cursor phases', () => {
  it('preToolUse simulates a Write or Delete without a session', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(cursorAdapter, 'pre-tool-use', pre(dir, 'Write', { file_path: path.join(dir, 'src/b.ts'), content: 'b' }), dir);
    await runAdapter(cursorAdapter, 'pre-tool-use', pre(dir, 'Delete', { file_path: path.join(dir, 'src/a.ts') }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.edits])).toEqual([
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'b.ts'), content: 'b' }]],
      ['pre-edit', null, [{ path: path.join(dir, 'src', 'a.ts'), content: null }]],
    ]);
  });

  it('postToolUse runs a pre-edit of the file on disk, or a pre-tool, with the session and the workspace root', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(cursorAdapter, 'post-tool-use', post(dir, 'Write', { file_path: path.join(dir, 'src/a.ts'), content: 'x' }), dir);
    await runAdapter(cursorAdapter, 'post-tool-use', post(dir, 'Shell', { command: 'npm test', working_directory: dir }), dir);
    await runAdapter(cursorAdapter, 'post-tool-use', post(dir, 'Read', { file_path: 'src/a.ts' }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.root, c.edits, c.isShell])).toEqual([
      ['pre-edit', 'conv-1', normalizeHarnessPath(root(dir)), [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 1;\n' }], false],
      ['pre-tool', 'conv-1', normalizeHarnessPath(root(dir)), [], true],
      ['pre-tool', 'conv-1', normalizeHarnessPath(root(dir)), [], false],
    ]);
  });

  it('stop and subagentStop pass loop_count as stop_hook_active, and skip aborted or unfinished work', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(cursorAdapter, 'stop', payload(dir, 'stop', { status: 'completed', loop_count: 0 }), dir);
    await runAdapter(cursorAdapter, 'stop', payload(dir, 'stop', { status: 'completed', loop_count: 1 }), dir);
    await runAdapter(cursorAdapter, 'stop', payload(dir, 'stop', { status: 'aborted', loop_count: 0 }), dir);
    await runAdapter(cursorAdapter, 'subagent-stop', payload(dir, 'subagentStop', { subagent_type: 'explore', status: 'completed', task: 't', loop_count: 0 }), dir);
    await runAdapter(cursorAdapter, 'subagent-stop', payload(dir, 'subagentStop', { subagent_type: 'explore', status: 'error', task: 't', loop_count: 0 }), dir);
    expect(calls.map((c) => [c.phase, c.stopHookActive])).toEqual([
      ['stop', false],
      ['stop', true],
      ['subagent-stop', false],
    ]);
  });
});

describe('cursor answers', () => {
  const write = (dir: string) => pre(dir, 'Write', { file_path: 'src/c.ts', content: 'c' });
  const deny = line({ permission: 'deny', agent_message: TEXT, user_message: 'slopbuckets denied this edit because buckets.config.json would become invalid. The agent got the details.' });
  decisionCases(cursorAdapter, 'pre-tool-use', write, project, { silent: { code: 0, out: NEUTRAL }, context: { code: 0, out: NEUTRAL }, deny: { code: 0, out: deny }, block: { code: 0, out: NEUTRAL }, note: { code: 0, out: NEUTRAL } });
  decisionCases(cursorAdapter, 'pre-tool-use', (dir) => pre(dir, 'Read', { file_path: 'x' }), project, { silent: { code: 0, out: NEUTRAL }, context: { code: 0, out: NEUTRAL }, deny: { code: 0, out: NEUTRAL }, block: { code: 0, out: NEUTRAL }, note: { code: 0, out: NEUTRAL } });
  const context = line({ additional_context: TEXT });
  decisionCases(cursorAdapter, 'post-tool-use', (dir) => post(dir, 'Write', { file_path: 'src/a.ts' }), project, { context: { code: 0, out: context } });
  decisionCases(cursorAdapter, 'post-tool-use', (dir) => post(dir, 'Shell', { command: 'ls' }), project, { context: { code: 0, out: context } });
  const followup = line({ followup_message: TEXT });
  decisionCases(cursorAdapter, 'stop', (dir) => payload(dir, 'stop', { status: 'completed', loop_count: 0 }), project, { block: { code: 0, out: followup } });
  decisionCases(cursorAdapter, 'subagent-stop', (dir) => payload(dir, 'subagentStop', { status: 'completed', loop_count: 0 }), project, { block: { code: 0, out: followup } });
});

describe('cursor fails open', () => {
  it('answers {} on preToolUse and nothing elsewhere when the core crashes or the payload is broken', async () => {
    const dir = project();
    crashingCore();
    expect(await runAdapter(cursorAdapter, 'pre-tool-use', pre(dir, 'Write', { file_path: 'x.ts', content: '' }), dir)).toMatchObject({ code: 0, out: NEUTRAL });
    for (const event of ['post-tool-use', 'stop', 'subagent-stop']) {
      expect(await runAdapter(cursorAdapter, event, post(dir, 'Write', { file_path: 'x.ts' }), dir)).toMatchObject({ code: 0, out: '' });
    }
    fakeCore();
    expect(await runAdapter(cursorAdapter, 'pre-tool-use', '{', dir)).toEqual({ code: 0, out: NEUTRAL, err: '' });
  });
});

describe('cursor install', () => {
  installSuite(cursorAdapter, {
    file: '.cursor/hooks.json',
    userText: JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './hooks/format.sh' }], stop: [{ command: 'say done' }] } }, null, 2),
    fresh(json) {
      expect(json).toEqual({
        version: 1,
        hooks: {
          preToolUse: [{ command: 'buckets hook --agent cursor pre-tool-use', matcher: 'Write|Delete', timeout: 60 }],
          postToolUse: [{ command: 'buckets hook --agent cursor post-tool-use', timeout: 60 }],
          stop: [{ command: 'buckets hook --agent cursor stop', loop_limit: 1, timeout: 600 }],
          subagentStop: [{ command: 'buckets hook --agent cursor subagent-stop', loop_limit: 1, timeout: 600 }],
        },
      });
    },
  });

  it('migrates a 1.x install: drops beforeShellExecution, failClosed and the postToolUse matcher, keeps user hooks', () => {
    const v1 = {
      version: 1,
      hooks: {
        preToolUse: [
          { command: './guard.sh', failClosed: true },
          { command: 'buckets hook --agent cursor pre-tool-use', matcher: 'Write|Delete', failClosed: true, timeout: 30 },
        ],
        beforeShellExecution: [{ command: 'buckets hook --agent cursor before-shell-execution', failClosed: true, timeout: 30 }],
        postToolUse: [{ command: 'buckets hook --agent cursor post-tool-use', matcher: 'Write', timeout: 300 }],
        stop: [{ command: 'buckets hook --agent cursor stop', loop_limit: 1, timeout: 600 }],
        subagentStop: [{ command: 'buckets hook --agent cursor subagent-stop', timeout: 600 }],
      },
    };
    const dir = makeProject({ '.cursor/hooks.json': JSON.stringify(v1, null, 2) }, false);
    expect(cursorAdapter.install(dir, { skill: null })).toEqual([
      { status: 'done', text: 'Updated the Cursor hooks in .cursor/hooks.json (preToolUse, beforeShellExecution, postToolUse, subagentStop)' },
    ]);
    const json = JSON.parse(readFile(dir, '.cursor/hooks.json'));
    expect(json.hooks.beforeShellExecution).toBeUndefined();
    expect(json.hooks.preToolUse).toEqual([
      { command: './guard.sh', failClosed: true },
      { command: 'buckets hook --agent cursor pre-tool-use', matcher: 'Write|Delete', timeout: 60 },
    ]);
    expect(json.hooks.subagentStop).toEqual([{ command: 'buckets hook --agent cursor subagent-stop', loop_limit: 1, timeout: 600 }]);
    expect(cursorAdapter.install(dir, { skill: null })).toEqual([{ status: 'kept', text: 'Cursor hooks are already in .cursor/hooks.json' }]);
  });
});

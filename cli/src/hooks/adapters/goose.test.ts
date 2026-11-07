// The Goose adapter with Goose payloads: PreToolUse runs the core on edits and shell commands and can only deny, Stop
// blocks once per session by mark. Install writes a plugin.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { normalizeHarnessPath } from '../input.js';
import { installSuite, line, newSessionId, runAdapter } from './adapter-test-kit.js';
import { GOOSE_HOOKS_FILE, GOOSE_MANIFEST, GOOSE_MATCHER, gooseAdapter } from './goose.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(dir: string, event: string, extra: Record<string, unknown>, session = 'gs-1') {
  return { event, session_id: session, working_dir: dir, ...extra };
}

const pre = (dir: string, tool: string, input: Record<string, unknown>) => payload(dir, 'PreToolUse', { matcher_context: tool, tool_call_id: 'c1', tool_name: tool, tool_input: input });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('goose phases', () => {
  it('maps write and edit (with or without the extension prefix) to pre-edit, shell to a shell pre-tool, with the session', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(gooseAdapter, 'pre-tool-use', pre(dir, 'write', { path: path.join(dir, 'src/b.ts'), content: 'b' }), dir);
    await runAdapter(gooseAdapter, 'pre-tool-use', pre(dir, 'developer__edit', { path: path.join(dir, 'src/a.ts'), before: '1', after: '2' }), dir);
    await runAdapter(gooseAdapter, 'pre-tool-use', pre(dir, 'developer__shell', { command: 'npm test' }), dir);
    expect(calls.map((c) => [c.phase, c.sessionId, c.root, c.edits, c.isShell])).toEqual([
      ['pre-edit', 'gs-1', normalizeHarnessPath(dir), [{ path: path.join(dir, 'src', 'b.ts'), content: 'b' }], false],
      ['pre-edit', 'gs-1', normalizeHarnessPath(dir), [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 2;\n' }], false],
      ['pre-tool', 'gs-1', normalizeHarnessPath(dir), [], true],
    ]);
  });

  it('Stop blocks once per session by mark, and a subagent session has its own mark', async () => {
    const dir = project();
    const calls = fakeCore((input) => (input.stopHookActive ? { kind: 'silent' } : { kind: 'block', text: TEXT }));
    const session = newSessionId();
    const stop = (id: string) => payload(dir, 'Stop', { last_assistant_message: 'done' }, id);
    const block = line({ decision: 'block', reason: TEXT });
    expect((await runAdapter(gooseAdapter, 'stop', stop(session), dir)).out).toBe(block);
    expect((await runAdapter(gooseAdapter, 'stop', stop(newSessionId()), dir)).out).toBe(block);
    expect((await runAdapter(gooseAdapter, 'stop', stop(session), dir)).out).toBe('');
    expect(calls.map((c) => c.stopHookActive)).toEqual([false, false, true]);
  });
});

describe('goose answers', () => {
  const block = line({ decision: 'block', reason: TEXT });
  decisionCases(gooseAdapter, 'pre-tool-use', (dir) => pre(dir, 'write', { path: 'src/c.ts', content: 'c' }), project, { deny: { code: 0, out: block } });
  decisionCases(gooseAdapter, 'pre-tool-use', (dir) => pre(dir, 'shell', { command: 'ls' }), project, {});
  decisionCases(gooseAdapter, 'stop', (dir) => payload(dir, 'Stop', {}, newSessionId()), project, { block: { code: 0, out: block } });
});

describe('goose fails open', () => {
  it('exits with 0 and prints nothing when the core crashes', async () => {
    const dir = project();
    crashingCore();
    for (const event of gooseAdapter.events) {
      expect(await runAdapter(gooseAdapter, event, pre(dir, 'write', { path: 'x.ts', content: '' }), dir)).toMatchObject({ code: 0, out: '' });
    }
  });
});

describe('goose install', () => {
  installSuite(gooseAdapter, {
    file: GOOSE_HOOKS_FILE,
    userText: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: './audit.sh' }] }] } }, null, 2),
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          PreToolUse: [{ matcher: GOOSE_MATCHER, hooks: [{ type: 'command', command: 'buckets hook --agent goose pre-tool-use', timeout: 60 }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent goose stop', timeout: 600 }] }],
        },
      });
    },
  });

  it('writes the plugin manifest', () => {
    const dir = makeProject({}, false);
    expect(gooseAdapter.install(dir, { skill: null }).map((s) => s.status)).toEqual(['done', 'done', 'todo']);
    expect(JSON.parse(readFile(dir, GOOSE_MANIFEST)).name).toBe('slopbuckets');
  });

  it('migrates a 1.x install: drops on_failure, sets the stop timeout', () => {
    const v1 = {
      hooks: {
        PreToolUse: [{ matcher: '(?:^|__)(?:shell|write|edit|text_editor)$', hooks: [{ type: 'command', command: 'buckets hook --agent goose pre-tool-use', timeout: 60, on_failure: 'block' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent goose stop', timeout: 300 }] }],
      },
    };
    const dir = makeProject({ [GOOSE_HOOKS_FILE]: JSON.stringify(v1, null, 2) }, false);
    expect(gooseAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: `Updated the Goose hooks in ${GOOSE_HOOKS_FILE} (PreToolUse, Stop)` });
    expect(readFile(dir, GOOSE_HOOKS_FILE)).not.toContain('on_failure');
    expect(gooseAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });
});

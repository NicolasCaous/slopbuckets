// The Cursor adapter with Cursor payloads: preToolUse for Write and Delete, beforeShellExecution, postToolUse, stop and
// subagentStop.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import {
  cleanProject,
  feedbackFor,
  installSuite,
  line,
  LOCK_DENY_REASON,
  lockNames,
  newSessionId,
  REFRESH_ALLOWED,
  REFRESH_DENIED,
  runAdapter,
  stopReportFor,
  violationProject,
} from './adapter-test-kit.js';
import { cursorAdapter } from './cursor.js';

afterEach(cleanupProjects);

const ALLOW = line({ permission: 'allow' });
const DENY = line({
  permission: 'deny',
  agent_message: LOCK_DENY_REASON,
  user_message: 'slopbuckets blocked this call: only a human may change buckets.lock.json or run `buckets refresh`.',
});

/** Cursor writes a Windows workspace root as /c:/Users/...; the adapter must undo that. */
function root(dir: string): string {
  return /^[A-Za-z]:/.test(dir) ? `/${dir.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`)}` : dir;
}

function payload(dir: string, event: string, extra: Record<string, unknown>, conversation = newSessionId()) {
  return {
    conversation_id: conversation,
    generation_id: newSessionId(),
    model: 'claude-4.5-sonnet',
    hook_event_name: event,
    cursor_version: '2.4.7',
    workspace_roots: [root(dir)],
    user_email: null,
    transcript_path: null,
    ...extra,
  };
}

const write = (dir: string, file: string) => payload(dir, 'preToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: '{}' }, tool_use_id: 'tool_1', cwd: dir });
const shell = (dir: string, command: string) => payload(dir, 'beforeShellExecution', { command, cwd: dir });

describe('cursor pre-tool-use and before-shell-execution', () => {
  it('answers allow explicitly for ordinary writes, reads and commands', async () => {
    const dir = violationProject();
    expect(await runAdapter(cursorAdapter, 'pre-tool-use', write(dir, path.join(dir, 'root', '_', 'main.ts')), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
    const read = payload(dir, 'preToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'buckets.lock.json') }, cwd: dir });
    expect(await runAdapter(cursorAdapter, 'pre-tool-use', read, dir)).toEqual({ code: 0, out: ALLOW, err: '' });
    expect(await runAdapter(cursorAdapter, 'before-shell-execution', shell(dir, 'npm test'), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
  });

  it('denies a write or delete of the lock under any name, with workspace roots in the /c:/ form', async () => {
    const dir = violationProject();
    for (const name of lockNames(dir)) {
      expect(await runAdapter(cursorAdapter, 'pre-tool-use', write(dir, name), dir)).toEqual({ code: 0, out: DENY, err: '' });
      const del = payload(dir, 'preToolUse', { tool_name: 'Delete', tool_input: { file_path: name }, cwd: dir });
      expect(await runAdapter(cursorAdapter, 'pre-tool-use', del, dir)).toEqual({ code: 0, out: DENY, err: '' });
    }
    // Without cwd, relative paths resolve from the workspace root.
    const bare = payload(dir, 'preToolUse', { tool_name: 'Write', tool_input: { path: 'buckets.lock.json' } });
    expect((await runAdapter(cursorAdapter, 'pre-tool-use', bare, dir)).out).toBe(DENY);
  });

  it('denies plain buckets refresh and allows buckets refresh --web, in both events', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) {
      expect(await runAdapter(cursorAdapter, 'before-shell-execution', shell(dir, command), dir)).toEqual({ code: 0, out: DENY, err: '' });
      const asTool = payload(dir, 'preToolUse', { tool_name: 'Shell', tool_input: { command }, cwd: dir });
      expect((await runAdapter(cursorAdapter, 'pre-tool-use', asTool, dir)).out).toBe(DENY);
    }
    for (const command of REFRESH_ALLOWED) expect(await runAdapter(cursorAdapter, 'before-shell-execution', shell(dir, command), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
    expect((await runAdapter(cursorAdapter, 'before-shell-execution', shell(dir, 'cat buckets.lock.json'), dir)).out).toBe(DENY);
  });

  it('answers allow on a broken payload', async () => {
    const dir = makeProject({});
    expect(await runAdapter(cursorAdapter, 'before-shell-execution', '{', dir)).toEqual({ code: 0, out: ALLOW, err: '' });
  });
});

describe('cursor post-tool-use', () => {
  it('reports the violations of a written file in additional_context', async () => {
    const dir = violationProject();
    const post = (file: string) => payload(dir, 'postToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_output: '{"ok":true}', cwd: dir });
    const feedback = await feedbackFor(dir, 'root/_/main.ts');
    expect(await runAdapter(cursorAdapter, 'post-tool-use', post(path.join(dir, 'root', '_', 'main.ts')), dir)).toEqual({ code: 0, out: line({ additional_context: feedback }), err: '' });
    expect(await runAdapter(cursorAdapter, 'post-tool-use', post(path.join(dir, 'root', 'log', '_', 'logger.ts')), dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('cursor stop and subagent-stop', () => {
  it('sends the report as a follow-up once per turn (loop_count 0) and never on a later loop', async () => {
    const dir = violationProject();
    const report = await stopReportFor(dir);
    const first = payload(dir, 'stop', { status: 'completed', loop_count: 0 });
    expect(await runAdapter(cursorAdapter, 'stop', first, dir)).toEqual({ code: 0, out: line({ followup_message: report }), err: '' });
    expect(await runAdapter(cursorAdapter, 'stop', { ...first, loop_count: 1 }, dir)).toEqual({ code: 0, out: '', err: '' });
    expect(await runAdapter(cursorAdapter, 'stop', { ...first, status: 'aborted' }, dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('without loop_count, blocks a subagent once and lets it finish on the next stop', async () => {
    const dir = violationProject();
    const report = await stopReportFor(dir, true);
    const sub = payload(dir, 'subagentStop', { subagent_type: 'explore', status: 'completed' });
    expect(await runAdapter(cursorAdapter, 'subagent-stop', sub, dir)).toEqual({ code: 0, out: line({ followup_message: report }), err: '' });
    expect(await runAdapter(cursorAdapter, 'subagent-stop', sub, dir)).toEqual({ code: 0, out: '', err: '' });
    expect((await runAdapter(cursorAdapter, 'subagent-stop', sub, dir)).out).not.toBe('');
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(cursorAdapter, 'stop', payload(dir, 'stop', { status: 'completed', loop_count: 0 }), dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('cursor install', () => {
  installSuite(cursorAdapter, {
    file: '.cursor/hooks.json',
    userText: JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './hooks/format.sh' }], stop: [{ command: 'say done' }] } }, null, 2),
    freshUninstallDeletes: true,
    fresh(json) {
      expect(json).toEqual({
        version: 1,
        hooks: {
          preToolUse: [{ command: 'buckets hook --agent cursor pre-tool-use', matcher: 'Write|Delete', timeout: 30 }],
          beforeShellExecution: [{ command: 'buckets hook --agent cursor before-shell-execution', timeout: 30 }],
          postToolUse: [{ command: 'buckets hook --agent cursor post-tool-use', matcher: 'Write', timeout: 300 }],
          stop: [{ command: 'buckets hook --agent cursor stop', loop_limit: 1, timeout: 600 }],
          subagentStop: [{ command: 'buckets hook --agent cursor subagent-stop', timeout: 600 }],
        },
      });
    },
  });

  it('removes failClosed from its own entries left by an older version, and only from those', () => {
    const old = {
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
    const dir = makeProject({ '.cursor/hooks.json': JSON.stringify(old, null, 2) }, false);
    expect(cursorAdapter.install(dir, { skill: null })).toEqual([{ status: 'done', text: 'Updated the Cursor hooks in .cursor/hooks.json (preToolUse, beforeShellExecution)' }]);
    const json = JSON.parse(readFile(dir, '.cursor/hooks.json'));
    expect(json.hooks.preToolUse).toEqual([
      { command: './guard.sh', failClosed: true },
      { command: 'buckets hook --agent cursor pre-tool-use', matcher: 'Write|Delete', timeout: 30 },
    ]);
    expect(json.hooks.beforeShellExecution).toEqual([{ command: 'buckets hook --agent cursor before-shell-execution', timeout: 30 }]);
    expect(cursorAdapter.install(dir, { skill: null })).toEqual([{ status: 'kept', text: 'Cursor hooks are already in .cursor/hooks.json' }]);
  });
});

// The Goose adapter with Goose payloads: PreToolUse for shell, write and edit, and Stop without stop_hook_active.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { cleanProject, installSuite, line, LOCK_DENY_REASON, lockNames, newSessionId, REFRESH_ALLOWED, REFRESH_DENIED, runAdapter, stopReportFor, violationProject } from './adapter-test-kit.js';
import { GOOSE_HOOKS_FILE, GOOSE_MANIFEST, GOOSE_MATCHER, gooseAdapter } from './goose.js';

afterEach(cleanupProjects);

/** Exit 0 with nothing on stdout is an allow for Goose. */
const ALLOW = '';
const DENY = line({ decision: 'block', reason: LOCK_DENY_REASON });

function tool(dir: string, name: string, input: Record<string, unknown>, session = newSessionId()) {
  return { event: 'PreToolUse', session_id: session, matcher_context: name, tool_name: name, tool_input: input, working_dir: dir, tool_call_id: 'call-1' };
}

const stopPayload = (dir: string, session: string) => ({ event: 'Stop', session_id: session, last_assistant_message: 'Done. I updated the file.', working_dir: dir });

describe('goose pre-tool-use', () => {
  it('stays silent for ordinary calls, which Goose reads as allow', async () => {
    const dir = violationProject();
    expect(await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'shell', { command: 'rg TODO' }), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
    expect(await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'write', { path: 'root/_/main.ts', content: 'x' }), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
  });

  it('blocks a write or edit of the lock under any name', async () => {
    const dir = violationProject();
    for (const name of lockNames(dir)) {
      expect(await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'write', { path: name, content: '{}' }), dir)).toEqual({ code: 0, out: DENY, err: '' });
      expect((await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'edit', { path: name, before: 'a', after: 'b' }), dir)).out).toBe(DENY);
      expect((await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'developer__text_editor', { command: 'str_replace', path: name }), dir)).out).toBe(DENY);
    }
    expect((await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'developer__text_editor', { command: 'view', path: 'buckets.lock.json' }), dir)).out).toBe(ALLOW);
  });

  it('blocks plain buckets refresh and allows buckets refresh --web', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) expect((await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'shell', { command }), dir)).out).toBe(DENY);
    for (const command of REFRESH_ALLOWED) expect((await runAdapter(gooseAdapter, 'pre-tool-use', tool(dir, 'shell', { command, timeout_secs: 600 }), dir)).out).toBe(ALLOW);
  });

  it('matches only the tools it guards', () => {
    const matcher = new RegExp(GOOSE_MATCHER);
    for (const name of ['shell', 'write', 'edit', 'developer__shell', 'developer__text_editor']) expect(matcher.test(name)).toBe(true);
    for (const name of ['tree', 'read_image', 'todo__todo_write', 'shellcheck']) expect(matcher.test(name)).toBe(false);
  });
});

describe('goose stop', () => {
  it('blocks once with the check report, then lets the agent finish', async () => {
    const dir = violationProject();
    const session = newSessionId();
    const report = await stopReportFor(dir);
    expect(await runAdapter(gooseAdapter, 'stop', stopPayload(dir, session), dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: report }), err: '' });
    expect(await runAdapter(gooseAdapter, 'stop', stopPayload(dir, session), dir)).toEqual({ code: 0, out: '', err: '' });
    expect((await runAdapter(gooseAdapter, 'stop', stopPayload(dir, session), dir)).out).toBe(line({ decision: 'block', reason: report }));
  });

  it('lets a clean project finish', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(gooseAdapter, 'stop', stopPayload(dir, newSessionId()), dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('goose install', () => {
  installSuite(gooseAdapter, {
    file: GOOSE_HOOKS_FILE,
    userText: '{\n  "hooks": {\n    // logs every shell call\n    "PostToolUse": [{ "matcher": "shell", "hooks": [{ "type": "command", "command": "./log.sh" }] }]\n  }\n}\n',
    fresh(json) {
      const hooks = json.hooks as Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
      expect(hooks.PreToolUse).toEqual([{ matcher: GOOSE_MATCHER, hooks: [{ type: 'command', command: 'buckets hook --agent goose pre-tool-use', timeout: 60 }] }]);
      expect(JSON.stringify(json)).not.toContain('on_failure');
      expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'buckets hook --agent goose stop', timeout: 300 }] }]);
    },
    freshUninstallDeletes: true,
  });

  it('updates an older install that failed closed, and keeps the user hooks next to it', () => {
    const old = {
      hooks: {
        PreToolUse: [
          { matcher: GOOSE_MATCHER, hooks: [{ type: 'command', command: 'buckets hook --agent goose pre-tool-use', timeout: 60, on_failure: 'block' }] },
          { matcher: 'shell', hooks: [{ type: 'command', command: './audit.sh', on_failure: 'block' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent goose stop', timeout: 300 }] }],
      },
    };
    const dir = makeProject({ [GOOSE_HOOKS_FILE]: `${JSON.stringify(old, null, 2)}\n` }, false);
    expect(gooseAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: `Updated the Goose hooks in ${GOOSE_HOOKS_FILE} (PreToolUse)` });
    const json = JSON.parse(readFileSync(path.join(dir, GOOSE_HOOKS_FILE), 'utf8')) as typeof old;
    expect(json.hooks.PreToolUse[0]!.hooks[0]).toEqual({ type: 'command', command: 'buckets hook --agent goose pre-tool-use', timeout: 60 });
    expect(json.hooks.PreToolUse[1]).toEqual(old.hooks.PreToolUse[1]);
    expect(gooseAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });

  it('writes the plugin manifest and removes the whole plugin on uninstall', () => {
    const dir = makeProject({}, false);
    gooseAdapter.install(dir, { skill: null });
    expect(JSON.parse(readFileSync(path.join(dir, GOOSE_MANIFEST), 'utf8'))).toMatchObject({ name: 'slopbuckets' });
    gooseAdapter.uninstall(dir);
    expect(existsSync(path.join(dir, '.agents/plugins/slopbuckets'))).toBe(false);
  });
});

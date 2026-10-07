// The Crush adapter with Crush payloads: PreToolUse for bash and the file tools, deny as JSON, never allow.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { parseJson } from '../../core/json.js';
import { installSuite, line, LOCK_DENY_REASON, guardedNames, REFRESH_ALLOWED, REFRESH_DENIED, runAdapter, violationProject, asUpdateDeny, UPDATE_ALLOWED, UPDATE_DENIED } from './adapter-test-kit.js';
import { CRUSH_MATCHER, crushAdapter, crushTarget } from './crush.js';

afterEach(cleanupProjects);

const DENY = line({ decision: 'deny', reason: LOCK_DENY_REASON });
const SILENT = { code: 0, out: '', err: '' };

function payload(dir: string, tool: string, input: Record<string, unknown>) {
  return { event: 'PreToolUse', session_id: '313909e', cwd: dir, tool_name: tool, tool_input: input };
}

describe('crush pre-tool-use', () => {
  it('stays silent for ordinary calls, so the permission prompt still runs', async () => {
    const dir = violationProject();
    expect(await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'bash', { command: 'npm test' }), dir)).toEqual(SILENT);
    expect(await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'edit', { file_path: path.join(dir, 'root/_/main.ts'), old_string: 'a', new_string: 'b' }), dir)).toEqual(SILENT);
    expect(await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'view', { file_path: 'buckets.lock.json' }), dir)).toEqual(SILENT);
  });

  it('denies a write to the lock under any name, from every file tool', async () => {
    const dir = violationProject();
    for (const [name, as] of guardedNames(dir)) {
      for (const tool of ['edit', 'multiedit', 'write']) expect(await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, tool, { file_path: name, content: '{}' }), dir)).toEqual(as({ code: 0, out: DENY, err: '' }));
    }
    expect((await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'download', { url: 'https://example.com/x', file_path: 'buckets.lock.json' }), dir)).out).toBe(DENY);
  });

  it('denies plain buckets refresh or an installing buckets update and allows buckets refresh --web', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) expect((await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'bash', { command }), dir)).out).toBe(DENY);
    for (const command of REFRESH_ALLOWED) expect(await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'bash', { command }), dir)).toEqual(SILENT);
    for (const command of UPDATE_DENIED) expect((await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'bash', { command }), dir)).out).toBe(asUpdateDeny(DENY));
    for (const command of UPDATE_ALLOWED) expect(await runAdapter(crushAdapter, 'pre-tool-use', payload(dir, 'bash', { command }), dir)).toEqual(SILENT);
  });

  it('uses CRUSH_PROJECT_DIR as the session folder', async () => {
    const dir = violationProject();
    const sub = path.join(dir, 'root');
    expect((await runAdapter(crushAdapter, 'pre-tool-use', payload(sub, 'write', { file_path: '../buckets.lock.json' }), sub, { CRUSH_PROJECT_DIR: dir })).out).toBe(DENY);
  });

  it('matches the tools it guards', () => {
    const matcher = new RegExp(CRUSH_MATCHER);
    for (const name of ['bash', 'edit', 'multiedit', 'write', 'download']) expect(matcher.test(name)).toBe(true);
    for (const name of ['view', 'agent', 'mcp_github_create_pull_request']) expect(matcher.test(name)).toBe(false);
  });
});

describe('crush install', () => {
  installSuite(crushAdapter, {
    file: '.crush.json',
    userText: '{\n  "$schema": "https://charm.land/crush.json",\n  "hooks": {\n    // no rm -rf\n    "PreToolUse": [{ "matcher": "^bash$", "command": "./hooks/no-rm-rf.sh" }]\n  }\n}\n',
    fresh(json) {
      expect((json.hooks as Record<string, unknown[]>).PreToolUse).toEqual([
        { name: 'slopbuckets lock guard', matcher: CRUSH_MATCHER, command: 'buckets hook --agent crush pre-tool-use', timeout: 60 },
      ]);
    },
    freshUninstallDeletes: true,
  });

  it('merges into an existing crush.json instead of adding .crush.json', () => {
    const dir = makeProject({ 'crush.json': '{ "options": { "debug": true } }\n' }, false);
    expect(crushTarget(dir)).toBe('crush.json');
    expect(crushAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done', text: expect.stringContaining('crush.json') });
    const json = parseJson(readFileSync(path.join(dir, 'crush.json'), 'utf8')) as Record<string, unknown>;
    expect(json.options).toEqual({ debug: true });
    crushAdapter.uninstall(dir);
    expect(parseJson(readFileSync(path.join(dir, 'crush.json'), 'utf8'))).toEqual({ options: { debug: true } });
  });
});

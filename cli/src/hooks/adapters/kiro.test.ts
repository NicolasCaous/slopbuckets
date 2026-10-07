// The Kiro adapter with Kiro CLI payloads: fs_write and execute_bash under their names and aliases, exit code 2.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { LOCK_DENY_REASON, guardedNames, REFRESH_ALLOWED, REFRESH_DENIED, runAdapter, violationProject, asUpdateDeny, UPDATE_ALLOWED, UPDATE_DENIED } from './adapter-test-kit.js';
import { KIRO_HOOK_FILE, KIRO_V1_HOOK, kiroAdapter } from './kiro.js';

afterEach(cleanupProjects);

const DENIED = { code: 2, out: '', err: `${LOCK_DENY_REASON}\n` };
const ALLOWED = { code: 0, out: '', err: '' };

function payload(dir: string, tool: string, input: Record<string, unknown>) {
  return { hook_event_name: 'preToolUse', cwd: dir, session_id: 'b7c1e2d4-1111-4222-8333-944445555666', tool_name: tool, tool_input: input };
}

describe('kiro pre-tool-use', () => {
  it('allows reads, ordinary writes and commands', async () => {
    const dir = violationProject();
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, 'fs_write', { command: 'create', path: 'root/_/main.ts', file_text: 'x' }), dir)).toEqual(ALLOWED);
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, 'execute_bash', { command: 'npm test' }), dir)).toEqual(ALLOWED);
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, 'fs_read', { operations: [{ mode: 'Line', path: 'buckets.lock.json' }] }), dir)).toEqual(ALLOWED);
  });

  it('denies a write to the lock under any name and any write tool, with exit code 2', async () => {
    const dir = violationProject();
    for (const [name, as] of guardedNames(dir)) {
      for (const tool of ['fs_write', 'write', 'str_replace', 'fs_append']) {
        expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, tool, { command: 'str_replace', path: name, old_str: 'a', new_str: 'b' }), dir)).toEqual(as(DENIED));
      }
    }
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, 'delete_file', { explanation: 'cleanup', targetFile: 'buckets.lock.json' }), dir)).toEqual(DENIED);
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, 'fs_write', { operations: [{ path: 'notes.md' }, { path: 'buckets.lock.json' }] }), dir)).toEqual(DENIED);
  });

  it('denies plain buckets refresh or an installing buckets update in every shell tool and allows buckets refresh --web', async () => {
    const dir = violationProject();
    for (const tool of ['execute_bash', 'shell', 'execute_pwsh']) {
      for (const command of REFRESH_DENIED) expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, tool, { command }), dir)).toEqual(DENIED);
      for (const command of REFRESH_ALLOWED) expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, tool, { command }), dir)).toEqual(ALLOWED);
      for (const command of UPDATE_DENIED) expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, tool, { command }), dir)).toEqual(asUpdateDeny(DENIED));
      for (const command of UPDATE_ALLOWED) expect(await runAdapter(kiroAdapter, 'pre-tool-use', payload(dir, tool, { command }), dir)).toEqual(ALLOWED);
    }
  });

  it('allows a broken payload', async () => {
    const dir = makeProject({});
    expect(await runAdapter(kiroAdapter, 'pre-tool-use', '{', dir)).toEqual(ALLOWED);
  });
});

describe('kiro install', () => {
  const read = (dir: string, file: string) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;

  it('writes the standalone hook file in a fresh project, tells about Kiro CLI 2.x, and is idempotent', () => {
    const dir = makeProject({}, false);
    const first = kiroAdapter.install(dir, { skill: null });
    expect(first[0]).toEqual({ status: 'done', text: `Installed the Kiro hook in ${KIRO_HOOK_FILE} (PreToolUse, for Kiro CLI 3 and the Kiro IDE)` });
    expect(first.some((s) => s.status === 'todo' && s.text.includes('Kiro CLI 2.x'))).toBe(true);
    expect(read(dir, KIRO_HOOK_FILE)).toEqual({ version: 'v1', hooks: [KIRO_V1_HOOK] });
    const text = readFileSync(path.join(dir, KIRO_HOOK_FILE), 'utf8');
    expect(kiroAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
    expect(readFileSync(path.join(dir, KIRO_HOOK_FILE), 'utf8')).toBe(text);
    expect(kiroAdapter.uninstall(dir)).toEqual([{ status: 'done', text: `Removed ${KIRO_HOOK_FILE}, which held only the slopbuckets hook` }]);
    expect(existsSync(path.join(dir, '.kiro/hooks'))).toBe(false);
    expect(kiroAdapter.uninstall(dir)).toEqual([]);
  });

  it("merges the hook into each agent config and keeps the user's hooks", () => {
    const agent = { name: 'dev', tools: ['*'], allowedTools: ['fs_read'], hooks: { agentSpawn: [{ command: 'git status' }], preToolUse: [{ matcher: 'execute_bash', command: './audit.sh' }] } };
    const dir = makeProject({ '.kiro/agents/dev.json': `${JSON.stringify(agent, null, 2)}\n`, '.kiro/agents/plain.json': '{ "name": "plain" }\n' }, false);
    const steps = kiroAdapter.install(dir, { skill: null });
    expect(steps.filter((s) => s.status === 'done').map((s) => s.text)).toEqual([
      `Installed the Kiro hook in ${KIRO_HOOK_FILE} (PreToolUse, for Kiro CLI 3 and the Kiro IDE)`,
      'Installed Kiro hooks in .kiro/agents/dev.json (preToolUse)',
      'Installed Kiro hooks in .kiro/agents/plain.json (preToolUse)',
    ]);
    const dev = read(dir, '.kiro/agents/dev.json') as typeof agent;
    expect(dev.hooks.preToolUse).toEqual([{ matcher: 'execute_bash', command: './audit.sh' }, { command: 'buckets hook --agent kiro pre-tool-use', timeout_ms: 60000 }]);
    expect(dev.hooks.agentSpawn).toEqual([{ command: 'git status' }]);
    expect(kiroAdapter.install(dir, { skill: null }).some((s) => s.status === 'done')).toBe(false);
    kiroAdapter.uninstall(dir);
    expect(read(dir, '.kiro/agents/dev.json')).toEqual(agent);
    expect(read(dir, '.kiro/agents/plain.json')).toEqual({ name: 'plain' });
  });

  it('keeps other hooks in its own hook file and refuses a broken one', () => {
    const other = { name: 'fmt', trigger: 'PostFileSave', action: { type: 'command', command: 'prettier --write' } };
    const dir = makeProject({ [KIRO_HOOK_FILE]: JSON.stringify({ version: 'v1', hooks: [other] }) }, false);
    expect(kiroAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    expect(read(dir, KIRO_HOOK_FILE)).toEqual({ version: 'v1', hooks: [other, KIRO_V1_HOOK] });
    expect(kiroAdapter.uninstall(dir)).toEqual([{ status: 'done', text: `Removed the slopbuckets hook from ${KIRO_HOOK_FILE}` }]);
    expect(read(dir, KIRO_HOOK_FILE)).toEqual({ version: 'v1', hooks: [other] });

    const broken = makeProject({ [KIRO_HOOK_FILE]: '[1]' }, false);
    expect(kiroAdapter.install(broken, { skill: null })[0]).toMatchObject({ status: 'failed' });
    expect(readFileSync(path.join(broken, KIRO_HOOK_FILE), 'utf8')).toBe('[1]');
  });
});

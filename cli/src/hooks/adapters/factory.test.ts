// The Factory Droid adapter with Droid payloads: Execute, Create, Edit and ApplyPatch, Stop and SubagentStop. Droid
// skips its own prompts when a hook answers allow, so every allow here must be silent.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import {
  cleanProject,
  feedbackFor,
  installSuite,
  line,
  LOCK_DENY_REASON,
  guardedNames,
  newSessionId,
  patch,
  REFRESH_ALLOWED,
  REFRESH_DENIED,
  runAdapter,
  stopReportFor,
  violationProject,
  asUpdateDeny,
  UPDATE_ALLOWED,
  UPDATE_DENIED,
} from './adapter-test-kit.js';
import { factoryAdapter } from './factory.js';

afterEach(cleanupProjects);

const DENY = line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON } });
const SILENT = { code: 0, out: '', err: '' };

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return { session_id: newSessionId(), transcript_path: path.join(dir, '.factory', 'session.jsonl'), cwd: dir, permission_mode: 'auto-high', hook_event_name: event, ...extra };
}

const tool = (dir: string, event: string, name: string, input: unknown) => payload(dir, event, { tool_name: name, tool_input: input });

describe('factory pre-tool-use', () => {
  it('never answers allow', async () => {
    const dir = violationProject();
    expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Execute', { command: 'npm test', riskLevel: 'low' }), dir)).toEqual(SILENT);
    expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Create', { file_path: path.join(dir, 'root/_/x.ts'), content: 'x' }), dir)).toEqual(SILENT);
    expect(await runAdapter(factoryAdapter, 'pre-tool-use', 'garbage', dir)).toEqual(SILENT);
  });

  it('denies Create, Edit and ApplyPatch on the lock under any name', async () => {
    const dir = violationProject();
    for (const [name, as] of guardedNames(dir)) {
      expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Create', { file_path: name, content: '{}' }), dir)).toEqual(as({ code: 0, out: DENY, err: '' }));
      expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Edit', { file_path: name, old_str: 'a', new_str: 'b' }), dir)).toEqual(as({ code: 0, out: DENY, err: '' }));
      const text = patch([`*** Update File: ${name}`, '@@', '-a', '+b']);
      expect((await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'ApplyPatch', text), dir)).out).toBe(as(DENY));
      expect((await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'ApplyPatch', { patch: text }), dir)).out).toBe(as(DENY));
    }
  });

  it('denies plain buckets refresh or an installing buckets update and stays silent for buckets refresh --web', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Execute', { command }), dir)).toEqual({ code: 0, out: DENY, err: '' });
    for (const command of REFRESH_ALLOWED) expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Execute', { command }), dir)).toEqual(SILENT);
    for (const command of UPDATE_DENIED) expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Execute', { command }), dir)).toEqual(asUpdateDeny({ code: 0, out: DENY, err: '' }));
    for (const command of UPDATE_ALLOWED) expect(await runAdapter(factoryAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'Execute', { command }), dir)).toEqual(SILENT);
  });

  it('takes the session folder from FACTORY_PROJECT_DIR', async () => {
    const dir = violationProject();
    const input = tool(dir, 'PreToolUse', 'Create', { file_path: 'buckets.lock.json', content: '{}' });
    delete (input as Record<string, unknown>).cwd;
    expect((await runAdapter(factoryAdapter, 'pre-tool-use', input, makeProject({}, false), { FACTORY_PROJECT_DIR: dir })).out).toBe(DENY);
  });
});

describe('factory post-tool-use', () => {
  it('reports the violations of an edited file with decision block', async () => {
    const dir = violationProject();
    const feedback = await feedbackFor(dir, 'root/_/main.ts');
    const edit = tool(dir, 'PostToolUse', 'Edit', { file_path: path.join(dir, 'root', '_', 'main.ts'), old_str: 'a', new_str: 'b' });
    expect(await runAdapter(factoryAdapter, 'post-tool-use', { ...edit, tool_response: { success: true } }, dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: feedback }), err: '' });
    const applied = tool(dir, 'PostToolUse', 'ApplyPatch', patch(['*** Update File: root/_/main.ts', '@@', '-a', '+b']));
    expect((await runAdapter(factoryAdapter, 'post-tool-use', applied, dir)).out).toBe(line({ decision: 'block', reason: feedback }));
    expect(await runAdapter(factoryAdapter, 'post-tool-use', tool(dir, 'PostToolUse', 'Create', { file_path: 'root/log/_/logger.ts' }), dir)).toEqual(SILENT);
  });
});

describe('factory stop and subagent-stop', () => {
  it('blocks once and lets the agent finish when stop_hook_active is set', async () => {
    const dir = violationProject();
    for (const [event, name] of [
      ['stop', 'Stop'],
      ['subagent-stop', 'SubagentStop'],
    ] as const) {
      const first = payload(dir, name, { stop_hook_active: false });
      expect(await runAdapter(factoryAdapter, event, first, dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: await stopReportFor(dir, event === 'subagent-stop') }), err: '' });
      expect(await runAdapter(factoryAdapter, event, { ...first, stop_hook_active: true }, dir)).toEqual(SILENT);
    }
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(factoryAdapter, 'stop', payload(dir, 'Stop', { stop_hook_active: false }), dir)).toEqual(SILENT);
  });
});

describe('factory install', () => {
  installSuite(factoryAdapter, {
    file: '.factory/hooks.json',
    userText: JSON.stringify({ PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write "$FILE"' }] }] }, null, 2),
    freshUninstallDeletes: true,
    fresh(json) {
      expect(json).toEqual({
        PreToolUse: [{ matcher: 'Execute|Create|Edit|MultiEdit|ApplyPatch', hooks: [{ type: 'command', command: 'buckets hook --agent factory pre-tool-use' }] }],
        PostToolUse: [{ matcher: 'Create|Edit|MultiEdit|ApplyPatch', hooks: [{ type: 'command', command: 'buckets hook --agent factory post-tool-use' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent factory stop' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent factory subagent-stop' }] }],
      });
    },
  });

  it('adds its hook to a group the user shares with other hooks and removes only its own', () => {
    const shared = { PreToolUse: [{ matcher: 'Execute', hooks: [{ type: 'command', command: 'audit' }, { type: 'command', command: 'buckets hook --agent factory pre-tool-use' }] }] };
    const dir = makeProject({ '.factory/hooks.json': JSON.stringify(shared) }, false);
    expect(factoryAdapter.install(dir, { skill: null })[0]!.text).toBe('Installed Factory Droid hooks in .factory/hooks.json (PostToolUse, Stop, SubagentStop)');
    factoryAdapter.uninstall(dir);
    expect(JSON.parse(readFile(dir, '.factory/hooks.json'))).toEqual({ PreToolUse: [{ matcher: 'Execute', hooks: [{ type: 'command', command: 'audit' }] }] });
  });
});

// The Codex CLI adapter with Codex payloads: PreToolUse for apply_patch and Bash, Stop, SubagentStop and PostCompact.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { normalizeHarnessPath } from '../input.js';
import { installSuite, line, patch, runAdapter } from './adapter-test-kit.js';
import { codexAdapter } from './codex.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return {
    session_id: 'sess-1',
    turn_id: 'turn-1',
    transcript_path: path.join(dir, '.codex', 'transcript.jsonl'),
    cwd: dir,
    hook_event_name: event,
    model: 'gpt-5.3-codex',
    permission_mode: 'default',
    ...extra,
  };
}

const bash = (dir: string) => payload(dir, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' } });
const applyPatch = (dir: string, text: string) => payload(dir, 'PreToolUse', { tool_name: 'apply_patch', tool_use_id: 'call_2', tool_input: { command: text } });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('codex phases', () => {
  it('maps apply_patch to pre-edit with the patched text of each file', async () => {
    const dir = project();
    const calls = fakeCore();
    const text = patch(['*** Update File: src/a.ts', '@@', '-export const a = 1;', '+export const a = 2;', '*** Add File: src/b.ts', '+export const b = 1;']);
    await runAdapter(codexAdapter, 'pre-tool-use', applyPatch(dir, text), dir);
    expect(calls).toEqual([
      {
        phase: 'pre-edit',
        sessionId: 'sess-1',
        agentId: null,
        cwd: normalizeHarnessPath(dir),
        root: normalizeHarnessPath(dir),
        toolName: 'apply_patch',
        edits: [
          { path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 2;\n' },
          { path: path.join(dir, 'src', 'b.ts'), content: 'export const b = 1;\n' },
        ],
        isShell: false,
        stopHookActive: false,
      },
    ]);
  });

  it('maps Bash to pre-tool with isShell, and other tools to pre-tool', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(codexAdapter, 'pre-tool-use', bash(dir), dir);
    await runAdapter(codexAdapter, 'pre-tool-use', payload(dir, 'PreToolUse', { tool_name: 'mcp__docs__search', tool_input: { q: 'x' } }), dir);
    expect(calls.map((c) => [c.phase, c.toolName, c.isShell])).toEqual([
      ['pre-tool', 'Bash', true],
      ['pre-tool', 'mcp__docs__search', false],
    ]);
  });

  it('maps Stop and SubagentStop with stop_hook_active and the agent id, and PostCompact', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(codexAdapter, 'stop', payload(dir, 'Stop', { stop_hook_active: true, last_assistant_message: 'done' }), dir);
    const sub = { agent_id: 'agent-7', agent_type: 'worker', agent_transcript_path: 'x', stop_hook_active: false, last_assistant_message: 'ok' };
    await runAdapter(codexAdapter, 'subagent-stop', payload(dir, 'SubagentStop', sub), dir);
    await runAdapter(codexAdapter, 'post-compact', payload(dir, 'PostCompact', { trigger: 'auto' }), dir);
    expect(calls.map((c) => [c.phase, c.stopHookActive, c.agentId])).toEqual([
      ['stop', true, null],
      ['subagent-stop', false, 'agent-7'],
      ['post-compact', false, null],
    ]);
  });
});

describe('codex answers', () => {
  const context = line({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: TEXT } });
  const deny = line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: TEXT } });
  const block = line({ decision: 'block', reason: TEXT });
  const edit = (dir: string) => applyPatch(dir, patch(['*** Add File: src/c.ts', '+x']));
  decisionCases(codexAdapter, 'pre-tool-use', edit, project, { context: { code: 0, out: context }, deny: { code: 0, out: deny } });
  decisionCases(codexAdapter, 'pre-tool-use', bash, project, { context: { code: 0, out: context } });
  decisionCases(codexAdapter, 'stop', (dir) => payload(dir, 'Stop', { stop_hook_active: false }), project, { block: { code: 0, out: block } });
  decisionCases(codexAdapter, 'subagent-stop', (dir) => payload(dir, 'SubagentStop', { agent_id: 'a', stop_hook_active: false }), project, { block: { code: 0, out: block } });
  decisionCases(codexAdapter, 'post-compact', (dir) => payload(dir, 'PostCompact', { trigger: 'manual' }), project, {});
});

describe('codex fails open', () => {
  it('exits with 0 and prints nothing when the core crashes or the payload is broken', async () => {
    const dir = project();
    crashingCore();
    for (const event of codexAdapter.events) {
      const result = await runAdapter(codexAdapter, event, applyPatch(dir, patch(['*** Add File: x.ts', '+x'])), dir);
      expect(result).toMatchObject({ code: 0, out: '' });
      expect(result.err).toContain('core crashed');
    }
    fakeCore();
    expect(await runAdapter(codexAdapter, 'pre-tool-use', 'not json', dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('codex install', () => {
  installSuite(codexAdapter, {
    file: '.codex/hooks.json',
    userText: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 .codex/guard.py' }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, null, 2),
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'buckets hook --agent codex pre-tool-use', timeout: 60 }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent codex stop', timeout: 600 }] }],
          SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent codex subagent-stop', timeout: 600 }] }],
          PostCompact: [{ hooks: [{ type: 'command', command: 'buckets hook --agent codex post-compact', timeout: 30 }] }],
        },
      });
    },
  });

  it('asks the human to approve the hooks in /hooks when they change', () => {
    const dir = makeProject({}, false);
    expect(codexAdapter.install(dir, { skill: null }).map((s) => s.status)).toEqual(['done', 'todo']);
    expect(codexAdapter.install(dir, { skill: null }).map((s) => s.status)).toEqual(['kept']);
  });

  it('migrates a 1.x install: drops PostToolUse and the PreToolUse matcher, adds PostCompact', () => {
    const v1 = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash|apply_patch|Edit|Write', hooks: [{ type: 'command', command: 'buckets hook --agent codex pre-tool-use', timeout: 60 }] }],
        PostToolUse: [{ matcher: 'apply_patch|Edit|Write', hooks: [{ type: 'command', command: 'buckets hook --agent codex post-tool-use', timeout: 300 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }, { hooks: [{ type: 'command', command: 'buckets hook --agent codex stop', timeout: 600 }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent codex subagent-stop', timeout: 600 }] }],
      },
    };
    const dir = makeProject({ '.codex/hooks.json': JSON.stringify(v1, null, 2) }, false);
    expect(codexAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: 'Updated the Codex CLI hooks in .codex/hooks.json (PreToolUse, PostToolUse, PostCompact)' });
    const json = JSON.parse(readFile(dir, '.codex/hooks.json'));
    expect(Object.keys(json.hooks).sort()).toEqual(['PostCompact', 'PreToolUse', 'Stop', 'SubagentStop']);
    expect(json.hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: 'buckets hook --agent codex pre-tool-use', timeout: 60 }] }]);
    expect(json.hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'say done' }] });
    const text = readFile(dir, '.codex/hooks.json');
    expect(codexAdapter.install(dir, { skill: null })).toEqual([{ status: 'kept', text: 'Codex CLI hooks are already in .codex/hooks.json' }]);
    expect(readFile(dir, '.codex/hooks.json')).toBe(text);
  });
});

// The Qwen Code adapter with Qwen payloads: PreToolUse for write_file, edit and run_shell_command, Stop, SubagentStop
// and PostCompact.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject, readFile } from '../../testing/fixture.js';
import { normalizeHarnessPath } from '../input.js';
import { installSuite, line, runAdapter } from './adapter-test-kit.js';
import { crashingCore, decisionCases, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';
import { qwenAdapter } from './qwen.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return { session_id: 'q-1', transcript_path: path.join(dir, 't.jsonl'), cwd: dir, hook_event_name: event, timestamp: '2026-10-24T10:00:00Z', ...extra };
}

const tool = (dir: string, name: string, input: Record<string, unknown>) =>
  payload(dir, 'PreToolUse', { tool_name: name, tool_input: input, tool_use_id: 'call_1', permission_mode: 'default' });
const project = () => makeProject({ 'src/a.ts': 'export const a = 1;\n' });

describe('qwen phases', () => {
  it('maps write_file and edit to pre-edit with the new text, run_shell_command to a shell pre-tool', async () => {
    const dir = project();
    const env = { QWEN_PROJECT_DIR: dir };
    const calls = fakeCore();
    await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'write_file', { file_path: path.join(dir, 'src/b.ts'), content: 'b' }), dir, env);
    await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'edit', { file_path: path.join(dir, 'src/a.ts'), old_string: '1', new_string: '2', replace_all: false }), dir, env);
    await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'run_shell_command', { command: 'npm test' }), dir, env);
    await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'read_file', { absolute_path: path.join(dir, 'src/a.ts') }), dir, env);
    expect(calls.map((c) => [c.phase, c.toolName, c.edits, c.isShell, c.root])).toEqual([
      ['pre-edit', 'write_file', [{ path: path.join(dir, 'src', 'b.ts'), content: 'b' }], false, normalizeHarnessPath(dir)],
      ['pre-edit', 'edit', [{ path: path.join(dir, 'src', 'a.ts'), content: 'export const a = 2;\n' }], false, normalizeHarnessPath(dir)],
      ['pre-tool', 'run_shell_command', [], true, normalizeHarnessPath(dir)],
      ['pre-tool', 'read_file', [], false, normalizeHarnessPath(dir)],
    ]);
  });

  it('passes the agent id inside a subagent, stop_hook_active, and PostCompact', async () => {
    const dir = project();
    const calls = fakeCore();
    await runAdapter(qwenAdapter, 'pre-tool-use', { ...tool(dir, 'run_shell_command', { command: 'ls' }), agent_id: 'sub-1', agent_type: 'explore' }, dir);
    await runAdapter(qwenAdapter, 'stop', payload(dir, 'Stop', { stop_hook_active: true, last_assistant_message: 'done' }), dir);
    await runAdapter(qwenAdapter, 'subagent-stop', payload(dir, 'SubagentStop', { stop_hook_active: false, agent_id: 'sub-1', agent_type: 'explore', agent_transcript_path: 'x' }), dir);
    await runAdapter(qwenAdapter, 'post-compact', payload(dir, 'PostCompact', { trigger: 'auto', compact_summary: 's' }), dir);
    expect(calls.map((c) => [c.phase, c.agentId, c.stopHookActive])).toEqual([
      ['pre-tool', 'sub-1', false],
      ['stop', null, true],
      ['subagent-stop', 'sub-1', false],
      ['post-compact', null, false],
    ]);
  });
});

describe('qwen answers', () => {
  const context = line({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: TEXT } });
  const deny = line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: TEXT } });
  const block = line({ decision: 'block', reason: TEXT });
  decisionCases(qwenAdapter, 'pre-tool-use', (dir) => tool(dir, 'write_file', { file_path: 'src/c.ts', content: 'c' }), project, { context: { code: 0, out: context }, deny: { code: 0, out: deny } });
  decisionCases(qwenAdapter, 'pre-tool-use', (dir) => tool(dir, 'run_shell_command', { command: 'ls' }), project, { context: { code: 0, out: context } });
  decisionCases(qwenAdapter, 'stop', (dir) => payload(dir, 'Stop', { stop_hook_active: false }), project, { block: { code: 0, out: block } });
  decisionCases(qwenAdapter, 'subagent-stop', (dir) => payload(dir, 'SubagentStop', { stop_hook_active: false, agent_id: 'a' }), project, { block: { code: 0, out: block } });
  decisionCases(qwenAdapter, 'post-compact', (dir) => payload(dir, 'PostCompact', { trigger: 'manual' }), project, {});
});

describe('qwen fails open', () => {
  it('exits with 0 and prints nothing when the core crashes', async () => {
    const dir = project();
    crashingCore();
    for (const event of qwenAdapter.events) {
      const result = await runAdapter(qwenAdapter, event, tool(dir, 'write_file', { file_path: 'x.ts', content: '' }), dir);
      expect(result).toMatchObject({ code: 0, out: '' });
    }
  });
});

describe('qwen install', () => {
  installSuite(qwenAdapter, {
    file: '.qwen/settings.json',
    userText: ['{', '  // project settings', '  "model": { "name": "qwen3-coder" },', '  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] }', '}', ''].join('\n'),
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen pre-tool-use', timeout: 60 }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen stop', timeout: 600 }] }],
          SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen subagent-stop', timeout: 600 }] }],
          PostCompact: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen post-compact', timeout: 30 }] }],
        },
      });
    },
  });

  it('migrates a 1.x install and keeps the other settings', () => {
    const v1 = {
      model: { name: 'qwen3-coder' },
      hooks: {
        PreToolUse: [{ matcher: 'write_file|edit|replace|run_shell_command', hooks: [{ type: 'command', command: 'buckets hook --agent qwen pre-tool-use' }] }],
        PostToolUse: [{ matcher: 'write_file|edit|replace', hooks: [{ type: 'command', command: 'buckets hook --agent qwen post-tool-use' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen stop' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen subagent-stop' }] }],
      },
    };
    const dir = makeProject({ '.qwen/settings.json': JSON.stringify(v1, null, 2) }, false);
    expect(qwenAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'done' });
    const json = JSON.parse(readFile(dir, '.qwen/settings.json'));
    expect(json.model).toEqual({ name: 'qwen3-coder' });
    expect(json.hooks.PostToolUse).toBeUndefined();
    expect(json.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen stop', timeout: 600 }] }]);
    expect(qwenAdapter.install(dir, { skill: null })[0]).toMatchObject({ status: 'kept' });
  });
});

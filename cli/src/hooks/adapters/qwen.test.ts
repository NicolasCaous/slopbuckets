// The Qwen Code adapter with Qwen payloads: write_file, edit and run_shell_command (and their Claude aliases), Stop
// and SubagentStop. A deny exits with 2 and writes the reason on stderr as well as the JSON.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
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
import { qwenAdapter } from './qwen.js';

afterEach(cleanupProjects);

const DENIED = {
  code: 2,
  out: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON } }),
  err: `${LOCK_DENY_REASON}\n`,
};
const SILENT = { code: 0, out: '', err: '' };

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return { session_id: newSessionId(), transcript_path: path.join(dir, '.qwen', 'chat.jsonl'), cwd: dir, hook_event_name: event, permission_mode: 'default', ...extra };
}

const tool = (dir: string, event: string, name: string, input: Record<string, unknown>) => payload(dir, event, { tool_name: name, tool_input: input });

describe('qwen pre-tool-use', () => {
  it('allows ordinary calls with no output', async () => {
    const dir = violationProject();
    expect(await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'run_shell_command', { command: 'npm test', is_background: false }), dir)).toEqual(SILENT);
    expect(await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'write_file', { file_path: path.join(dir, 'root/_/x.ts'), content: 'x' }), dir)).toEqual(SILENT);
  });

  it('denies write_file, edit and the Write alias on the lock under any name', async () => {
    const dir = violationProject();
    for (const name of lockNames(dir)) {
      for (const tool_name of ['write_file', 'edit', 'Write']) {
        expect(await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', tool_name, { file_path: name, content: '{}', old_string: 'a', new_string: 'b' }), dir)).toEqual(DENIED);
      }
    }
  });

  it('takes the session folder from QWEN_PROJECT_DIR', async () => {
    const dir = violationProject();
    const input = tool(dir, 'PreToolUse', 'write_file', { file_path: 'buckets.lock.json', content: '{}' });
    delete (input as Record<string, unknown>).cwd;
    expect((await runAdapter(qwenAdapter, 'pre-tool-use', input, makeProject({}, false), { QWEN_PROJECT_DIR: dir })).code).toBe(2);
  });

  it('denies plain buckets refresh and allows buckets refresh --web', async () => {
    const dir = violationProject();
    for (const name of ['run_shell_command', 'Bash']) {
      for (const command of REFRESH_DENIED) expect(await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', name, { command }), dir)).toEqual(DENIED);
      for (const command of REFRESH_ALLOWED) expect(await runAdapter(qwenAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', name, { command }), dir)).toEqual(SILENT);
    }
  });
});

describe('qwen post-tool-use', () => {
  it('reports the violations of an edited file in additionalContext', async () => {
    const dir = violationProject();
    const feedback = await feedbackFor(dir, 'root/_/main.ts');
    const edit = tool(dir, 'PostToolUse', 'edit', { file_path: path.join(dir, 'root', '_', 'main.ts'), old_string: 'a', new_string: 'b' });
    const out = line({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: feedback } });
    expect(await runAdapter(qwenAdapter, 'post-tool-use', { ...edit, tool_response: { llmContent: 'ok' }, tool_use_id: 'toolu_1' }, dir)).toEqual({ code: 0, out, err: '' });
    expect(await runAdapter(qwenAdapter, 'post-tool-use', tool(dir, 'PostToolUse', 'write_file', { file_path: 'root/log/_/logger.ts' }), dir)).toEqual(SILENT);
  });
});

describe('qwen stop and subagent-stop', () => {
  it('blocks once and lets the agent finish when stop_hook_active is set', async () => {
    const dir = violationProject();
    for (const [event, name] of [
      ['stop', 'Stop'],
      ['subagent-stop', 'SubagentStop'],
    ] as const) {
      const first = payload(dir, name, { stop_hook_active: false });
      expect(await runAdapter(qwenAdapter, event, first, dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: await stopReportFor(dir, event === 'subagent-stop') }), err: '' });
      expect(await runAdapter(qwenAdapter, event, { ...first, stop_hook_active: true }, dir)).toEqual(SILENT);
    }
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(qwenAdapter, 'stop', payload(dir, 'Stop', { stop_hook_active: false }), dir)).toEqual(SILENT);
  });
});

describe('qwen install', () => {
  installSuite(qwenAdapter, {
    file: '.qwen/settings.json',
    userText: ['{', '  // personal', '  "model": { "name": "qwen3-coder-plus" },', '  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }] }', '}', ''].join('\n'),
    freshUninstallDeletes: true,
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          PreToolUse: [{ matcher: 'write_file|edit|replace|run_shell_command', hooks: [{ type: 'command', command: 'buckets hook --agent qwen pre-tool-use' }] }],
          PostToolUse: [{ matcher: 'write_file|edit|replace', hooks: [{ type: 'command', command: 'buckets hook --agent qwen post-tool-use' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen stop' }] }],
          SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent qwen subagent-stop' }] }],
        },
      });
    },
  });
});

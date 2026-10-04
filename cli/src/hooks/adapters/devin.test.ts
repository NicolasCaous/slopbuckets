// The Devin Desktop adapter with Devin Local payloads: lowercase tool names (write, edit, exec, delete, move) and Stop.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects } from '../../testing/fixture.js';
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
import { devinAdapter } from './devin.js';

afterEach(cleanupProjects);

const DENIED = {
  code: 2,
  out: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON } }),
  err: `${LOCK_DENY_REASON}\n`,
};
const SILENT = { code: 0, out: '', err: '' };

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return { session_id: newSessionId(), cwd: dir, hook_event_name: event, ...extra };
}

const tool = (dir: string, event: string, name: string, input: Record<string, unknown>) => payload(dir, event, { tool_name: name, tool_input: input });

describe('devin pre-tool-use', () => {
  it('allows ordinary calls with no output', async () => {
    const dir = violationProject();
    expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'exec', { command: 'npm test' }), dir)).toEqual(SILENT);
    expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'read', { file_path: 'buckets.lock.json' }), dir)).toEqual(SILENT);
  });

  it('denies write, edit, delete and move of the lock under any name and argument spelling', async () => {
    const dir = violationProject();
    for (const name of lockNames(dir)) {
      expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'write', { file_path: name, content: '{}' }), dir)).toEqual(DENIED);
      expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'edit', { path: name, old_string: 'a', new_string: 'b' }), dir)).toEqual(DENIED);
      expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'delete', { target_file: name }), dir)).toEqual(DENIED);
      expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'move', { old_path: name, new_path: 'old.json' }), dir)).toEqual(DENIED);
    }
  });

  it('denies plain buckets refresh and allows buckets refresh --web, under command or command_line', async () => {
    const dir = violationProject();
    for (const key of ['command', 'command_line']) {
      for (const command of REFRESH_DENIED) expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'exec', { [key]: command }), dir)).toEqual(DENIED);
      for (const command of REFRESH_ALLOWED) expect(await runAdapter(devinAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'exec', { [key]: command }), dir)).toEqual(SILENT);
    }
  });
});

describe('devin post-tool-use', () => {
  it('reports the violations of an edited file with decision block', async () => {
    const dir = violationProject();
    const out = line({ decision: 'block', reason: await feedbackFor(dir, 'root/_/main.ts') });
    expect(await runAdapter(devinAdapter, 'post-tool-use', tool(dir, 'PostToolUse', 'edit', { file_path: path.join(dir, 'root', '_', 'main.ts') }), dir)).toEqual({ code: 0, out, err: '' });
    expect(await runAdapter(devinAdapter, 'post-tool-use', tool(dir, 'PostToolUse', 'write', { file_path: 'root/log/_/logger.ts' }), dir)).toEqual(SILENT);
  });
});

describe('devin stop', () => {
  it('blocks once and lets the agent finish when stop_hook_active is set', async () => {
    const dir = violationProject();
    const first = payload(dir, 'Stop', { stop_hook_active: false });
    expect(await runAdapter(devinAdapter, 'stop', first, dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: await stopReportFor(dir) }), err: '' });
    expect(await runAdapter(devinAdapter, 'stop', { ...first, stop_hook_active: true }, dir)).toEqual(SILENT);
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(devinAdapter, 'stop', payload(dir, 'Stop', { stop_hook_active: false }), dir)).toEqual(SILENT);
  });
});

describe('devin install', () => {
  installSuite(devinAdapter, {
    file: '.devin/hooks.v1.json',
    userText: JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'write', hooks: [{ type: 'command', command: 'npx prettier --write .' }] }] } }, null, 2),
    freshUninstallDeletes: true,
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          PreToolUse: [{ matcher: 'write|edit|exec|delete|move', hooks: [{ type: 'command', command: 'buckets hook --agent devin pre-tool-use' }] }],
          PostToolUse: [{ matcher: 'write|edit', hooks: [{ type: 'command', command: 'buckets hook --agent devin post-tool-use' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent devin stop' }] }],
        },
      });
    },
  });
});

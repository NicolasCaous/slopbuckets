// The Auggie adapter with Augment CLI payloads: launch-process, save-file, str-replace-editor and remove-files, and a
// Stop that may come without stop_hook_active.
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
import { auggieAdapter } from './auggie.js';

afterEach(cleanupProjects);

const DENIED = {
  code: 2,
  out: line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON } }),
  err: `${LOCK_DENY_REASON}\n`,
};
const SILENT = { code: 0, out: '', err: '' };

/** Auggie sends no cwd; the workspace root is the session folder. */
function payload(dir: string, event: string, extra: Record<string, unknown>, conversation = newSessionId()) {
  return { conversation_id: conversation, workspace_roots: [dir], hook_event_name: event, ...extra };
}

const tool = (dir: string, event: string, name: string, input: Record<string, unknown>) => payload(dir, event, { tool_name: name, tool_input: input });

describe('auggie pre-tool-use', () => {
  it('allows ordinary calls with no output, including a view of the lock', async () => {
    const dir = violationProject();
    expect(await runAdapter(auggieAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'launch-process', { command: 'npm test', wait: true, max_wait_seconds: 600, cwd: dir }), dir)).toEqual(SILENT);
    expect(await runAdapter(auggieAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'str-replace-editor', { command: 'view', path: 'buckets.lock.json' }), dir)).toEqual(SILENT);
  });

  it('denies save-file, str-replace-editor and remove-files on the lock under any name', async () => {
    const dir = violationProject();
    for (const name of lockNames(dir)) {
      expect(await runAdapter(auggieAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'save-file', { path: name, file_content: '{}' }), dir)).toEqual(DENIED);
      const edit = tool(dir, 'PreToolUse', 'str-replace-editor', { command: 'str_replace', path: name, old_str_1: 'a', new_str_1: 'b', old_str_start_line_number_1: 1, old_str_end_line_number_1: 1 });
      expect(await runAdapter(auggieAdapter, 'pre-tool-use', edit, dir)).toEqual(DENIED);
      expect(await runAdapter(auggieAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'remove-files', { file_paths: ['notes.md', name] }), dir)).toEqual(DENIED);
    }
  });

  it('denies plain buckets refresh and allows buckets refresh --web', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) expect(await runAdapter(auggieAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'launch-process', { command, wait: true }), dir)).toEqual(DENIED);
    for (const command of REFRESH_ALLOWED) expect(await runAdapter(auggieAdapter, 'pre-tool-use', tool(dir, 'PreToolUse', 'launch-process', { command, wait: false }), dir)).toEqual(SILENT);
  });
});

describe('auggie post-tool-use', () => {
  it('reports the violations of a saved or edited file with decision block', async () => {
    const dir = violationProject();
    const out = line({ decision: 'block', reason: await feedbackFor(dir, 'root/_/main.ts') });
    expect(await runAdapter(auggieAdapter, 'post-tool-use', tool(dir, 'PostToolUse', 'save-file', { path: 'root/_/main.ts', file_content: 'x' }), dir)).toEqual({ code: 0, out, err: '' });
    const edit = tool(dir, 'PostToolUse', 'str-replace-editor', { command: 'str_replace', path: path.join(dir, 'root', '_', 'main.ts') });
    expect((await runAdapter(auggieAdapter, 'post-tool-use', edit, dir)).out).toBe(out);
    expect(await runAdapter(auggieAdapter, 'post-tool-use', tool(dir, 'PostToolUse', 'save-file', { path: 'root/log/_/logger.ts' }), dir)).toEqual(SILENT);
  });
});

describe('auggie stop', () => {
  it('blocks once and lets the agent finish, with or without stop_hook_active', async () => {
    const dir = violationProject();
    const block = { code: 0, out: line({ decision: 'block', reason: await stopReportFor(dir) }), err: '' };
    const flagged = payload(dir, 'Stop', { stop_hook_active: false });
    expect(await runAdapter(auggieAdapter, 'stop', flagged, dir)).toEqual(block);
    expect(await runAdapter(auggieAdapter, 'stop', { ...flagged, stop_hook_active: true }, dir)).toEqual(SILENT);
    const bare = payload(dir, 'Stop', {});
    expect(await runAdapter(auggieAdapter, 'stop', bare, dir)).toEqual(block);
    expect(await runAdapter(auggieAdapter, 'stop', bare, dir)).toEqual(SILENT);
    expect(await runAdapter(auggieAdapter, 'stop', bare, dir)).toEqual(block);
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(auggieAdapter, 'stop', payload(dir, 'Stop', {}), dir)).toEqual(SILENT);
  });
});

describe('auggie install', () => {
  installSuite(auggieAdapter, {
    file: '.augment/settings.json',
    userText: ['{', '  // shared with the team', '  "hooks": {', '    "SessionStart": [{ "hooks": [{ "type": "command", "command": "./scripts/env.sh" }] }]', '  }', '}', ''].join('\n'),
    freshUninstallDeletes: true,
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          PreToolUse: [{ matcher: 'launch-process|save-file|str-replace-editor|remove-files', hooks: [{ type: 'command', command: 'buckets hook --agent auggie pre-tool-use' }] }],
          PostToolUse: [{ matcher: 'save-file|str-replace-editor', hooks: [{ type: 'command', command: 'buckets hook --agent auggie post-tool-use' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent auggie stop' }] }],
        },
      });
    },
  });
});

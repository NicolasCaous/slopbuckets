// The Codex CLI adapter with Codex payloads: apply_patch edits, Bash commands, Stop and SubagentStop.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
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
import { codexAdapter } from './codex.js';

afterEach(cleanupProjects);

const DENY = line({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_DENY_REASON } });

function payload(dir: string, event: string, extra: Record<string, unknown>) {
  return {
    session_id: newSessionId(),
    turn_id: 'turn-1',
    transcript_path: path.join(dir, '.codex', 'transcript.jsonl'),
    cwd: dir,
    hook_event_name: event,
    model: 'gpt-5.3-codex',
    permission_mode: 'default',
    ...extra,
  };
}

const bash = (dir: string, command: string) => payload(dir, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command } });
const applyPatch = (dir: string, event: string, text: string) => payload(dir, event, { tool_name: 'apply_patch', tool_use_id: 'call_2', tool_input: { command: text } });

describe('codex pre-tool-use', () => {
  it('allows ordinary commands and patches with no output', async () => {
    const dir = violationProject();
    expect(await runAdapter(codexAdapter, 'pre-tool-use', bash(dir, 'npm test'), dir)).toEqual({ code: 0, out: '', err: '' });
    const edit = applyPatch(dir, 'PreToolUse', patch(['*** Update File: root/_/main.ts', '@@', '-a', '+b']));
    expect(await runAdapter(codexAdapter, 'pre-tool-use', edit, dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('denies a patch that adds, updates, deletes or moves the lock under any name, with a reason', async () => {
    const dir = violationProject();
    for (const [name, as] of guardedNames(dir)) {
      for (const lines of [[`*** Add File: ${name}`, '+{}'], [`*** Update File: ${name}`, '@@', '-a', '+b'], [`*** Delete File: ${name}`], ['*** Update File: notes.md', `*** Move to: ${name}`]]) {
        for (const crlf of [false, true]) {
          expect(await runAdapter(codexAdapter, 'pre-tool-use', applyPatch(dir, 'PreToolUse', patch(lines, crlf)), dir)).toEqual(as({ code: 0, out: DENY, err: '' }));
        }
      }
    }
    // A Windows path in the header, as Codex on Windows writes it.
    const windows = patch([`*** Update File: ${dir.split('/').join('\\')}\\buckets.lock.json`, '@@', '-a', '+b']);
    expect((await runAdapter(codexAdapter, 'pre-tool-use', applyPatch(dir, 'PreToolUse', windows), dir)).out).toBe(DENY);
    // The heredoc form through the shell is a shell command that names the lock.
    expect((await runAdapter(codexAdapter, 'pre-tool-use', bash(dir, `apply_patch <<'EOF'\n${patch(['*** Add File: buckets.lock.json', '+{}'])}\nEOF`), dir)).out).toBe(DENY);
  });

  it('denies plain buckets refresh or an installing buckets update and allows buckets refresh --web', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) expect(await runAdapter(codexAdapter, 'pre-tool-use', bash(dir, command), dir)).toEqual({ code: 0, out: DENY, err: '' });
    for (const command of REFRESH_ALLOWED) expect(await runAdapter(codexAdapter, 'pre-tool-use', bash(dir, command), dir)).toEqual({ code: 0, out: '', err: '' });
    for (const command of UPDATE_DENIED) expect(await runAdapter(codexAdapter, 'pre-tool-use', bash(dir, command), dir)).toEqual(asUpdateDeny({ code: 0, out: DENY, err: '' }));
    for (const command of UPDATE_ALLOWED) expect(await runAdapter(codexAdapter, 'pre-tool-use', bash(dir, command), dir)).toEqual({ code: 0, out: '', err: '' });
    // An argv array, as older builds sent the shell tool.
    const argv = payload(dir, 'PreToolUse', { tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'buckets refresh'] } });
    expect((await runAdapter(codexAdapter, 'pre-tool-use', argv, dir)).out).toBe(DENY);
  });

  it('reads a broken payload as nothing to guard', async () => {
    const dir = makeProject({});
    expect(await runAdapter(codexAdapter, 'pre-tool-use', 'not json', dir)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('codex post-tool-use', () => {
  it('reports the violations of patched files in additionalContext and nothing for clean files', async () => {
    const dir = violationProject();
    const bad = applyPatch(dir, 'PostToolUse', patch(['*** Update File: root/_/main.ts', '@@', '-a', '+b', '*** Add File: root/log/_/logger.ts', '+x']));
    const feedback = await feedbackFor(dir, 'root/_/main.ts');
    expect(await runAdapter(codexAdapter, 'post-tool-use', bad, dir)).toEqual({
      code: 0,
      out: line({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: feedback } }),
      err: '',
    });
    const clean = applyPatch(dir, 'PostToolUse', patch(['*** Update File: root/log/_/logger.ts', '@@', '-a', '+b', '*** Delete File: root/old.ts']));
    expect(await runAdapter(codexAdapter, 'post-tool-use', clean, dir)).toEqual({ code: 0, out: '', err: '' });
  });

  it('checks the target of a move, not its source', async () => {
    const dir = violationProject();
    const moved = applyPatch(dir, 'PostToolUse', patch(['*** Update File: root/_/gone.ts', '*** Move to: root/_/main.ts', '@@', '-a', '+b']));
    expect((await runAdapter(codexAdapter, 'post-tool-use', moved, dir)).out).toContain('root/_/main.ts');
  });
});

describe('codex stop and subagent-stop', () => {
  it('blocks once with the check report and lets the agent finish on the retry', async () => {
    const dir = violationProject();
    for (const [event, name] of [
      ['stop', 'Stop'],
      ['subagent-stop', 'SubagentStop'],
    ] as const) {
      const report = await stopReportFor(dir, event === 'subagent-stop');
      const first = payload(dir, name, { stop_hook_active: false, last_assistant_message: 'Done.' });
      expect(await runAdapter(codexAdapter, event, first, dir)).toEqual({ code: 0, out: line({ decision: 'block', reason: report }), err: '' });
      expect(await runAdapter(codexAdapter, event, { ...first, stop_hook_active: true }, dir)).toEqual({ code: 0, out: '', err: '' });
    }
  });

  it('says nothing for a clean project', async () => {
    const dir = await cleanProject();
    expect(await runAdapter(codexAdapter, 'stop', payload(dir, 'Stop', { stop_hook_active: false }), dir)).toMatchObject({ code: 0, out: '' });
  });
});

describe('codex install', () => {
  installSuite(codexAdapter, {
    file: '.codex/hooks.json',
    userText: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 .codex/guard.py' }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, null, 2),
    freshUninstallDeletes: true,
    fresh(json) {
      expect(json).toEqual({
        hooks: {
          PreToolUse: [{ matcher: 'Bash|apply_patch|Edit|Write', hooks: [{ type: 'command', command: 'buckets hook --agent codex pre-tool-use', timeout: 60 }] }],
          PostToolUse: [{ matcher: 'apply_patch|Edit|Write', hooks: [{ type: 'command', command: 'buckets hook --agent codex post-tool-use', timeout: 300 }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent codex stop', timeout: 600 }] }],
          SubagentStop: [{ hooks: [{ type: 'command', command: 'buckets hook --agent codex subagent-stop', timeout: 600 }] }],
        },
      });
    },
  });

  it('asks the human to approve the hooks in /hooks on the first install only', () => {
    const dir = makeProject({}, false);
    expect(codexAdapter.install(dir, { skill: null }).map((s) => s.status)).toEqual(['done', 'todo']);
    expect(codexAdapter.install(dir, { skill: null }).map((s) => s.status)).toEqual(['kept']);
  });
});

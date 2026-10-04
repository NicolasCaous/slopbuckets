// The Cline adapter with Cline payloads: stringified parameters, editor, apply_patch and run_commands calls.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { feedbackFor, line, LOCK_DENY_REASON, lockNames, patch, REFRESH_ALLOWED, REFRESH_DENIED, runAdapter, violationProject } from './adapter-test-kit.js';
import { cancelMessage, clineAdapter, clineCommands, clineParameters, powershellScript, unixScript } from './cline.js';

afterEach(cleanupProjects);

const ALLOW = line({ cancel: false });

/** Cline turns every parameter value that is not a string into a JSON string. */
function stringify(params: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
}

function payload(dir: string, hookName: 'PreToolUse' | 'PostToolUse', toolName: string, params: Record<string, unknown>) {
  const part = { toolName, parameters: stringify(params) };
  return {
    clineVersion: '4.2.0',
    hookName,
    timestamp: '1759590000000',
    taskId: '01K6P3M8Z7Q2W4E5R6T7Y8U9I0',
    workspaceRoots: [dir],
    userId: 'user-1',
    ...(hookName === 'PreToolUse' ? { preToolUse: part } : { postToolUse: { ...part, result: 'ok', success: true, executionTimeMs: 12 } }),
  };
}

const commands = (dir: string, list: unknown[]) => payload(dir, 'PreToolUse', 'run_commands', { commands: list });
const deny = (tool: string) => line({ cancel: true, errorMessage: cancelMessage(tool, LOCK_DENY_REASON) });

describe('cline parameters', () => {
  it('decodes stringified values and reads every command shape', () => {
    expect(clineParameters({ parameters: { commands: '["npm test","buckets check"]', path: '/a/b.ts' } })).toEqual({ commands: ['npm test', 'buckets check'], path: '/a/b.ts' });
    expect(clineParameters({ parameters: '{"path":"x"}' })).toEqual({ path: 'x' });
    expect(clineParameters({ parameters: { note: '[not json' } })).toEqual({ note: '[not json' });
    expect(clineCommands({ commands: ['a', { command: 'buckets', args: ['refresh'] }] })).toEqual(['a', 'buckets refresh']);
    expect(clineCommands({ command: 'ls' })).toEqual(['ls']);
  });
});

describe('cline pre-tool-use', () => {
  it('allows ordinary edits and commands with an explicit cancel: false', async () => {
    const dir = violationProject();
    expect(await runAdapter(clineAdapter, 'pre-tool-use', payload(dir, 'PreToolUse', 'editor', { path: path.join(dir, 'root/_/main.ts'), old_text: 'a', new_text: 'b' }), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
    expect(await runAdapter(clineAdapter, 'pre-tool-use', commands(dir, ['npm test']), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
    expect(await runAdapter(clineAdapter, 'pre-tool-use', payload(dir, 'PreToolUse', 'read_files', { files: [{ path: path.join(dir, 'buckets.lock.json') }] }), dir)).toEqual({ code: 0, out: ALLOW, err: '' });
  });

  it('cancels the task, saying why, for an editor or apply_patch write to the lock', async () => {
    const dir = violationProject();
    for (const name of lockNames(dir)) {
      expect(await runAdapter(clineAdapter, 'pre-tool-use', payload(dir, 'PreToolUse', 'editor', { path: name, new_text: '{}' }), dir)).toEqual({ code: 0, out: deny('editor'), err: '' });
      const input = patch([`*** Update File: ${name}`, '@@', '-a', '+b']);
      expect((await runAdapter(clineAdapter, 'pre-tool-use', payload(dir, 'PreToolUse', 'apply_patch', { input }), dir)).out).toBe(deny('apply_patch'));
    }
    const out = JSON.parse((await runAdapter(clineAdapter, 'pre-tool-use', payload(dir, 'PreToolUse', 'editor', { path: 'buckets.lock.json', new_text: '' }), dir)).out) as { errorMessage: string };
    expect(out.errorMessage).toContain('ends the whole task');
  });

  it('cancels for a plain buckets refresh in any command of the list, and allows buckets refresh --web', async () => {
    const dir = violationProject();
    for (const command of REFRESH_DENIED) expect((await runAdapter(clineAdapter, 'pre-tool-use', commands(dir, ['npm test', command]), dir)).out).toBe(deny('run_commands'));
    for (const command of REFRESH_ALLOWED) expect((await runAdapter(clineAdapter, 'pre-tool-use', commands(dir, [command]), dir)).out).toBe(ALLOW);
    // `buckets refresh --web` followed by another command in the list stays allowed: each command is judged alone.
    expect((await runAdapter(clineAdapter, 'pre-tool-use', commands(dir, ['buckets refresh --web', 'git status']), dir)).out).toBe(ALLOW);
    expect((await runAdapter(clineAdapter, 'pre-tool-use', commands(dir, [{ command: 'buckets', args: ['refresh'] }]), dir)).out).toBe(deny('run_commands'));
    // The older VS Code runtime.
    expect((await runAdapter(clineAdapter, 'pre-tool-use', payload(dir, 'PreToolUse', 'execute_command', { command: 'cat buckets.lock.json' }), dir)).out).toBe(deny('execute_command'));
  });

  it('allows on a broken payload', async () => {
    const dir = makeProject({});
    expect(await runAdapter(clineAdapter, 'pre-tool-use', 'not json', dir)).toEqual({ code: 0, out: ALLOW, err: '' });
  });
});

describe('cline post-tool-use', () => {
  it('hands the check report back in contextModification', async () => {
    const dir = violationProject();
    const result = await runAdapter(clineAdapter, 'post-tool-use', payload(dir, 'PostToolUse', 'editor', { path: path.join(dir, 'root/_/main.ts'), new_text: 'x' }), dir);
    expect(result).toEqual({ code: 0, out: line({ cancel: false, contextModification: await feedbackFor(dir, 'root/_/main.ts') }), err: '' });
    const input = patch(['*** Update File: root/_/main.ts', '@@', '-a', '+b']);
    expect(JSON.parse((await runAdapter(clineAdapter, 'post-tool-use', payload(dir, 'PostToolUse', 'apply_patch', { input }), dir)).out)).toMatchObject({ cancel: false, contextModification: expect.stringContaining('import-relative') });
  });

  it('says nothing more for a clean file, a failed tool or a command', async () => {
    const dir = violationProject();
    expect((await runAdapter(clineAdapter, 'post-tool-use', payload(dir, 'PostToolUse', 'editor', { path: path.join(dir, 'root/log/_/logger.ts') }), dir)).out).toBe(ALLOW);
    const edited = payload(dir, 'PostToolUse', 'editor', { path: path.join(dir, 'root/_/main.ts') }) as Record<string, unknown> & { postToolUse: Record<string, unknown> };
    const failed = { ...edited, postToolUse: { ...edited.postToolUse, success: false } };
    expect((await runAdapter(clineAdapter, 'post-tool-use', failed, dir)).out).toBe(ALLOW);
    expect((await runAdapter(clineAdapter, 'post-tool-use', payload(dir, 'PostToolUse', 'run_commands', { commands: ['ls'] }), dir)).out).toBe(ALLOW);
  });
});

describe('cline install', () => {
  const files = ['PreToolUse', 'PostToolUse', 'PreToolUse.ps1', 'PostToolUse.ps1'].map((f) => `.clinerules/hooks/${f}`);

  it('writes one script per event and platform, idempotently, and uninstalls them', () => {
    const dir = makeProject({}, false);
    const first = clineAdapter.install(dir, { skill: null });
    expect(first[0]).toMatchObject({ status: 'done' });
    expect(first.some((s) => s.status === 'todo' && s.text.includes('Enable Hooks'))).toBe(true);
    for (const file of files) expect(existsSync(path.join(dir, file))).toBe(true);
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PreToolUse'), 'utf8')).toBe(unixScript('pre-tool-use'));
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PostToolUse.ps1'), 'utf8')).toBe(powershellScript('post-tool-use'));
    expect(unixScript('pre-tool-use')).toContain('exec buckets hook --agent cline pre-tool-use');
    expect(powershellScript('post-tool-use')).toContain('& buckets hook --agent cline post-tool-use');
    if (process.platform !== 'win32') expect(statSync(path.join(dir, '.clinerules/hooks/PreToolUse')).mode & 0o111).not.toBe(0);

    expect(clineAdapter.install(dir, { skill: null })).toEqual([{ status: 'kept', text: 'The Cline hooks in .clinerules/hooks/ are up to date' }]);

    expect(clineAdapter.uninstall(dir)[0]).toMatchObject({ status: 'done' });
    for (const file of files) expect(existsSync(path.join(dir, file))).toBe(false);
    expect(existsSync(path.join(dir, '.clinerules/hooks'))).toBe(false);
    expect(clineAdapter.uninstall(dir)).toEqual([]);
  });

  it("leaves the user's own hook scripts and rules alone", () => {
    const dir = makeProject({ '.clinerules/hooks/PreToolUse': '#!/bin/sh\necho \'{"cancel":false}\'\n', '.clinerules/style.md': '# style\n' }, false);
    const steps = clineAdapter.install(dir, { skill: null });
    expect(steps[0]).toMatchObject({ status: 'done' });
    expect(steps.some((s) => s.status === 'todo' && s.text.includes('.clinerules/hooks/PreToolUse is your own hook'))).toBe(true);
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PreToolUse'), 'utf8')).toBe('#!/bin/sh\necho \'{"cancel":false}\'\n');
    clineAdapter.uninstall(dir);
    expect(readFileSync(path.join(dir, '.clinerules/hooks/PreToolUse'), 'utf8')).toBe('#!/bin/sh\necho \'{"cancel":false}\'\n');
    expect(existsSync(path.join(dir, '.clinerules/hooks/PostToolUse'))).toBe(false);
    expect(existsSync(path.join(dir, '.clinerules/style.md'))).toBe(true);
  });

  it('updates an outdated slopbuckets script', () => {
    const dir = makeProject({}, false);
    clineAdapter.install(dir, { skill: null });
    const file = path.join(dir, '.clinerules/hooks/PostToolUse');
    writeFileSync(file, readFileSync(file, 'utf8').replace('exec buckets', 'exec old-buckets'), 'utf8');
    expect(clineAdapter.install(dir, { skill: null })[0]).toEqual({ status: 'done', text: 'Installed the Cline hooks in .clinerules/hooks/ (PostToolUse)' });
    expect(readFileSync(file, 'utf8')).toBe(unixScript('post-tool-use'));
  });

  it('does not touch a .clinerules rules file', () => {
    const dir = makeProject({}, false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.clinerules'), 'Use tabs.\n', 'utf8');
    expect(clineAdapter.install(dir, { skill: null })).toEqual([expect.objectContaining({ status: 'todo' })]);
    expect(readFileSync(path.join(dir, '.clinerules'), 'utf8')).toBe('Use tabs.\n');
  });
});

// The run-time half of the JSON hook adapters: tool kinds, new file text from payloads, the core answer filter, the
// stop mark and the dispatch of an event.
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { fakeIo, testContext } from '../../testing/harness.js';
import { defineAdapter } from '../adapter.js';
import { hookContext } from './adapter-test-kit.js';
import { afterTool, beforeTool, capText, decide, decideStopByMark, denyBeforeEdit, eventInput, kindOf, pathsIn, replacements, runJson, stopMemory, type Where } from './json-run.js';
import { DECISIONS, fakeCore, restoreCoreAfterEach, TEXT } from './json-test-kit.js';

afterEach(cleanupProjects);
restoreCoreAfterEach();

const where = (dir: string): Where => ({ sessionId: 's1', agentId: null, cwd: dir, root: dir });
const abs = (dir: string, file: string) => path.resolve(dir, file);

describe('kindOf', () => {
  it('reads the table without case, then guesses from the name', () => {
    const table = { Bash: 'shell', apply_patch: 'patch' } as const;
    expect(kindOf('bash', table)).toBe('shell');
    expect(kindOf('APPLY_PATCH', table)).toBe('patch');
    expect(kindOf('write_to_file', table)).toBe('write');
    expect(kindOf('fs_delete', table)).toBe('delete');
    expect(kindOf('run_terminal_cmd', table)).toBe('shell');
    expect(kindOf('read_file', table)).toBe('other');
    expect(kindOf('', table)).toBe('other');
  });

  it('collects paths under every usual key', () => {
    expect(pathsIn({ file_path: 'a', path: 'b', paths: ['c', { path: 'd' }], file_paths: ['a'] })).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('capText', () => {
  it('keeps short text and cuts long text with a hint', () => {
    expect(capText('abc', 5, 'more')).toBe('abc');
    expect(capText('abcdef', 3, 'Run it.')).toBe('abc\n\n[The report is cut here. Run it.]');
  });
});

describe('stopMemory', () => {
  it('remembers one block per key, forgets it when taken, and ignores an old mark', () => {
    const base = makeProject({}, false);
    try {
      expect(stopMemory.takeBlocked('k', base)).toBe(false);
      stopMemory.rememberBlocked('k', base);
      expect(stopMemory.takeBlocked('other', base)).toBe(false);
      expect(stopMemory.takeBlocked('k', base)).toBe(true);
      expect(stopMemory.takeBlocked('k', base)).toBe(false);
      stopMemory.rememberBlocked('old', base);
      const file = path.join(base, '.buckets', 'sessions');
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      for (const name of readdirSync(file)) utimesSync(path.join(file, name), old, old);
      expect(stopMemory.takeBlocked('old', base)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('replacements', () => {
  it('reads one pair under the usual keys, numbered pairs, and replace_all or allow_multiple', () => {
    expect(replacements({ old_string: 'a', new_string: 'x' })).toEqual([{ old: 'a', new: 'x', all: false }]);
    expect(replacements({ old_str: 'a', new_str: 'x', allow_multiple: true })).toEqual([{ old: 'a', new: 'x', all: true }]);
    expect(replacements({ before: 'two', after: '2', replace_all: true })).toEqual([{ old: 'two', new: '2', all: true }]);
    expect(replacements({ old_str_1: 'a', new_str_1: 'A', old_str_2: 'c', new_str_2: 'C' })).toEqual([
      { old: 'a', new: 'A', all: false },
      { old: 'c', new: 'C', all: false },
    ]);
  });

  it('gives nothing for a pair that is not two strings, and an empty list without a pair', () => {
    expect(replacements({ old_string: 'a' })).toBeUndefined();
    expect(replacements({})).toEqual([]);
  });
});

describe('beforeTool and afterTool', () => {
  it('builds a pre-edit from a whole new text or a replacement applied to the file', () => {
    const dir = makeProject({ 'src/a.ts': 'const a = 1;\n' }, false);
    expect(beforeTool(where(dir), { name: 'Write', kind: 'write', args: { file_path: 'src/b.ts', content: 'b' } })).toEqual({
      ...where(dir),
      phase: 'pre-edit',
      toolName: 'Write',
      edits: [{ path: abs(dir, 'src/b.ts'), content: 'b' }],
      isShell: false,
      stopHookActive: false,
    });
    expect(beforeTool(where(dir), { name: 'edit', kind: 'write', args: { path: abs(dir, 'src/a.ts'), old_str: '1', new_str: '2' } }).edits).toEqual([{ path: abs(dir, 'src/a.ts'), content: 'const a = 2;\n' }]);
  });

  it('keeps an edit without text when the replacement cannot be applied', () => {
    const dir = makeProject({ 'src/a.ts': 'x\n' }, false);
    expect(beforeTool(where(dir), { name: 'edit', kind: 'write', args: { file_path: 'src/a.ts', old_string: 'y', new_string: 'z' } }).edits).toEqual([{ path: abs(dir, 'src/a.ts') }]);
  });

  it('reads a patch only for a patch tool or a call that names no file', () => {
    const dir = makeProject({}, false);
    const doc = '*** Begin Patch\n*** Add File: x.ts\n+x\n*** End Patch';
    expect(beforeTool(where(dir), { name: 'Write', kind: 'write', args: { file_path: 'notes.md', content: doc } }).edits).toEqual([{ path: abs(dir, 'notes.md'), content: doc }]);
    expect(beforeTool(where(dir), { name: 'apply_patch', kind: 'patch', args: {}, raw: doc }).edits).toEqual([{ path: abs(dir, 'x.ts'), content: 'x\n' }]);
  });

  it('makes deletes null, shells and reads pre-tool, and a view command a pre-tool', () => {
    const dir = makeProject({}, false);
    expect(beforeTool(where(dir), { name: 'remove-files', kind: 'delete', args: { file_paths: ['a.ts'] } }).edits).toEqual([{ path: abs(dir, 'a.ts'), content: null }]);
    expect(beforeTool(where(dir), { name: 'Bash', kind: 'shell', args: { command: 'ls' } })).toMatchObject({ phase: 'pre-tool', isShell: true, edits: [] });
    expect(beforeTool(where(dir), { name: 'Read', kind: 'other', args: { file_path: 'a.ts' } })).toMatchObject({ phase: 'pre-tool', isShell: false });
    expect(beforeTool(where(dir), { name: 'str_replace_editor', kind: 'write', args: { command: 'view', path: 'a.ts' } })).toMatchObject({ phase: 'pre-tool' });
    expect(beforeTool(where(dir), { name: '', kind: 'other', args: {} }).toolName).toBeNull();
  });

  it('after the tool, reads every touched file from disk, null when it is gone', () => {
    const dir = makeProject({ 'src/a.ts': 'now\n' }, false);
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Delete File: src/b.ts\n*** End Patch';
    expect(afterTool(where(dir), { name: 'apply_patch', kind: 'patch', args: { command: patch } })).toMatchObject({
      phase: 'pre-edit',
      edits: [
        { path: abs(dir, 'src/a.ts'), content: 'now\n' },
        { path: abs(dir, 'src/b.ts'), content: null },
      ],
    });
    expect(afterTool(where(dir), { name: 'Write', kind: 'write', args: { file_path: 'src/a.ts' } }, [{ path: 'given', content: 'g' }]).edits).toEqual([{ path: 'given', content: 'g' }]);
    expect(afterTool(where(dir), { name: 'Shell', kind: 'shell', args: { command: 'ls' } })).toMatchObject({ phase: 'pre-tool', isShell: true });
  });
});

describe('decide', () => {
  it('drops answers the phase cannot carry, empty text, and a block after a block', async () => {
    const ctx = () => hookContext();
    const dir = makeProject({}, false);
    fakeCore(DECISIONS.deny);
    expect(await decide(ctx(), beforeTool(where(dir), { name: 'Read', kind: 'other', args: {} }))).toEqual({ kind: 'silent' });
    fakeCore(DECISIONS.context);
    expect(await decide(ctx(), eventInput(where(dir), 'stop'))).toEqual({ kind: 'silent' });
    fakeCore({ kind: 'context', text: '' });
    expect(await decide(ctx(), beforeTool(where(dir), { name: 'Read', kind: 'other', args: {} }))).toEqual({ kind: 'silent' });
    fakeCore(DECISIONS.block);
    expect(await decide(ctx(), eventInput(where(dir), 'stop', true))).toEqual({ kind: 'silent' });
    expect(await decide(ctx(), eventInput(where(dir), 'stop', false))).toEqual(DECISIONS.block);
  });

  it('denies before an edit without a session, and asks nothing for a call that edits nothing', async () => {
    const dir = makeProject({}, false);
    const calls = fakeCore(DECISIONS.deny);
    expect(await denyBeforeEdit(hookContext(), where(dir), { name: 'Write', kind: 'write', args: { file_path: 'a', content: '' } })).toBe(TEXT);
    expect(calls[0]).toMatchObject({ phase: 'pre-edit', sessionId: null, agentId: null });
    expect(await denyBeforeEdit(hookContext(), where(dir), { name: 'Bash', kind: 'shell', args: { command: 'ls' } })).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('blocks a stop once by mark, then lets it end', async () => {
    const dir = makeProject({}, false);
    const key = `test:${randomUUID()}`;
    const calls = fakeCore((input) => (input.stopHookActive ? DECISIONS.silent : DECISIONS.block));
    expect(await decideStopByMark(hookContext(), eventInput(where(dir), 'stop'), key)).toEqual(DECISIONS.block);
    expect(await decideStopByMark(hookContext(), eventInput(where(dir), 'stop'), key)).toEqual(DECISIONS.silent);
    expect(await decideStopByMark(hookContext(), eventInput(where(dir), 'stop'), key)).toEqual(DECISIONS.block);
    expect(calls.map((c) => c.stopHookActive)).toEqual([false, true, false]);
  });
});

describe('runJson', () => {
  const adapter = defineAdapter({
    name: 'x',
    title: 'X',
    markers: [],
    hookFiles: [],
    handlers: {
      'pre-tool-use': async () => {
        throw new Error('boom');
      },
      stop: async (_ctx, io, payload) => {
        io.stdout(JSON.stringify(payload));
        return 2;
      },
    },
    neutral: { 'pre-tool-use': '{}\n' },
    install: () => [],
    uninstall: () => [],
  });

  it('hands the parsed payload to the handler of the event and returns its exit code', async () => {
    const io = fakeIo({ cwd: '.', stdin: '{"a":1}' });
    expect(await runJson(testContext(), io, adapter, 'stop')).toBe(2);
    expect(io.out).toBe('{"a":1}');
    expect(adapter.events).toEqual(['pre-tool-use', 'stop']);
  });

  it('turns a crash into stderr, the neutral answer of the event and exit 0', async () => {
    const io = fakeIo({ cwd: '.', stdin: '{}' });
    expect(await runJson(testContext(), io, adapter, 'pre-tool-use')).toBe(0);
    expect(io.out).toBe('{}\n');
    expect(io.err).toContain('buckets hook --agent x pre-tool-use: unexpected error: Error: boom');
  });
});

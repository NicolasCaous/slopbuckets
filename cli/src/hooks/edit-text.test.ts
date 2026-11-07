// The new text of edited files: the path guard, find-and-replace and apply_patch.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { claudeAdapter } from './adapters/claude.js';
import { runJson } from './adapters/json-run.js';
import { looksLikePatch, MAX_READ_BYTES, parsePatch, patchEdits, projectPath, readProjectText, replaceText } from './edit-text.js';

afterEach(cleanupProjects);

const abs = (dir: string, file: string) => path.resolve(dir, file);

describe('projectPath and readProjectText', () => {
  it('keeps paths inside the project and refuses the rest before touching the disk', () => {
    const dir = makeProject({ 'src/a.ts': 'a\n' }, false);
    expect(projectPath(dir, 'src/a.ts')).toBe(abs(dir, 'src/a.ts'));
    expect(projectPath(dir, '../x.ts')).toBeNull();
    expect(projectPath(dir, dir)).toBeNull();
    expect(projectPath(dir, '\\\\host\\share\\x.ts')).toBeNull();
    expect(projectPath(dir, '//host/share/x.ts')).toBeNull();
    expect(projectPath(dir, '\\\\.\\pipe\\x')).toBeNull();
    expect(projectPath(dir, '\\\\?\\C:\\x.ts')).toBeNull();
    if (process.platform === 'win32') expect(projectPath(dir, 'src/NUL.ts')).toBeNull();
    expect(readProjectText(dir, 'src/a.ts')).toBe('a\n');
    expect(readProjectText(dir, 'src/none.ts')).toBeNull();
    expect(readProjectText(dir, '../outside.ts')).toBeUndefined();
    expect(readProjectText(dir, 'src')).toBeUndefined();
  });

  it('does not read a file over the size cap or through a link', () => {
    const dir = makeProject({ 'big.ts': 'x'.repeat(MAX_READ_BYTES + 1), 'target/a.ts': 'a\n' }, false);
    expect(readProjectText(dir, 'big.ts')).toBeUndefined();
    symlinkSync(abs(dir, 'target'), abs(dir, 'linked'), 'junction');
    expect(readProjectText(dir, 'linked')).toBeUndefined();
  });

  it('never opens a named pipe that an edit names (the payload of the review proof)', async () => {
    const dir = makeProject({ 'buckets.config.json': '{"buckets":{}}\n' }, false);
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\slopbuckets-test-${process.pid}` : abs(dir, 'pipe.sock');
    let opened = 0;
    const server = net.createServer((socket) => {
      opened++;
      socket.write('x');
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      expect(readProjectText(dir, pipe)).toBeUndefined();
      expect(opened).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe('replaceText', () => {
  it('replaces the first match, every match with all, or exactly one with unique', () => {
    expect(replaceText('a b a', [{ old: 'a', new: 'x' }])).toBe('x b a');
    expect(replaceText('a b a', [{ old: 'a', new: 'x', all: true }])).toBe('x b x');
    expect(replaceText('a b a', [{ old: 'a', new: 'x' }], { unique: true })).toBeUndefined();
    expect(replaceText('a b', [{ old: 'a', new: 'x' }], { unique: true })).toBe('x b');
    expect(replaceText('a', [{ old: 'a', new: '$&$1' }])).toBe('$&$1');
  });

  it('applies a list in order and gives nothing when one does not apply or the list is empty', () => {
    expect(replaceText('a b c', [{ old: 'a', new: 'A' }, { old: 'c', new: 'C' }])).toBe('A b C');
    expect(replaceText('a', [{ old: 'z', new: 'x' }])).toBeUndefined();
    expect(replaceText(null, [{ old: 'a', new: 'x' }])).toBeUndefined();
    expect(replaceText('a', [])).toBeUndefined();
  });

  it('reads an empty old text only as the harness documents it', () => {
    expect(replaceText('a', [{ old: '', new: 'x' }])).toBeUndefined();
    expect(replaceText(null, [{ old: '', new: 'x' }], { emptyOld: 'new-file' })).toBe('x');
    expect(replaceText('', [{ old: '', new: 'x' }], { emptyOld: 'new-file' })).toBe('x');
    expect(replaceText('a', [{ old: '', new: 'x' }], { emptyOld: 'new-file' })).toBeUndefined();
    expect(replaceText('a', [{ old: '', new: 'x' }], { emptyOld: 'whole' })).toBe('x');
  });
});

describe('apply_patch', () => {
  it('reads headers only at the start of a line, so an indented one is context of an update', () => {
    const text = ['*** Begin Patch', '*** Update File: a.ts', ' *** Add File: b.ts', '-x', '+y', '*** End Patch'].join('\r\n');
    expect(parsePatch(text)).toEqual([{ op: 'update', path: 'a.ts', body: [' *** Add File: b.ts', '-x', '+y'] }]);
    expect(looksLikePatch('  *** Begin Patch')).toBe(false);
    expect(parsePatch('*** Update File: C:\\p\\my file.ts \n*** Move to: b.ts')).toEqual([{ op: 'update', path: 'C:\\p\\my file.ts', move: 'b.ts', body: [] }]);
  });

  it('adds, updates, deletes and moves files', () => {
    const dir = makeProject({ 'src/a.ts': 'one\ntwo\nthree\n', 'src/b.ts': 'b\n', 'src/c.ts': 'keep\nold\n' }, false);
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const n = 1;',
      '+',
      '*** Update File: src/a.ts',
      '@@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '*** Delete File: src/b.ts',
      '*** Update File: src/c.ts',
      '*** Move to: src/d.ts',
      '@@',
      ' keep',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    expect(patchEdits(patch, dir, dir)).toEqual([
      { path: abs(dir, 'src/new.ts'), content: 'export const n = 1;\n\n' },
      { path: abs(dir, 'src/a.ts'), content: 'one\nTWO\nthree\n' },
      { path: abs(dir, 'src/b.ts'), content: null },
      { path: abs(dir, 'src/c.ts'), content: null },
      { path: abs(dir, 'src/d.ts'), content: 'keep\nnew\n' },
    ]);
  });

  it('keeps CRLF line ends, follows the @@ anchor and gives nothing when the anchor is missing', () => {
    const dir = makeProject({ 'a.ts': 'function f() {\r\n  return 1;\r\n}\r\nfunction g() {\r\n  return 1;\r\n}\r\n' }, false);
    const patch = (anchor: string) => ['*** Begin Patch', '*** Update File: a.ts', `@@ ${anchor}`, '-  return 1;', '+  return 2;', '*** End Patch'].join('\r\n');
    expect(patchEdits(patch('function g() {'), dir, dir)).toEqual([{ path: abs(dir, 'a.ts'), content: 'function f() {\r\n  return 1;\r\n}\r\nfunction g() {\r\n  return 2;\r\n}\r\n' }]);
    expect(patchEdits(patch('function h() {'), dir, dir)).toEqual([{ path: abs(dir, 'a.ts') }]);
  });

  it('matches lines that differ only in surrounding spaces, appends a hunk without old lines and ends with a line break', () => {
    const dir = makeProject({ 'a.ts': 'x  \ny' }, false);
    expect(patchEdits(['*** Update File: a.ts', '@@', '-x', '+X', '*** Update File: a.ts', '@@', '+z'].join('\n'), dir, dir)).toEqual([
      { path: abs(dir, 'a.ts'), content: 'X\ny\n' },
      { path: abs(dir, 'a.ts'), content: 'x  \ny\nz\n' },
    ]);
  });

  it('leaves the text out when a hunk does not match, the file is missing or it lies outside the project', () => {
    const dir = makeProject({ 'a.ts': 'a\n' }, false);
    mkdirSync(abs(dir, 'sub'));
    writeFileSync(abs(dir, 'out.ts'), 'a\n');
    expect(patchEdits(['*** Update File: a.ts', '@@', '-nope', '+x', '*** Update File: gone.ts', '@@', '-a', '+b', '*** Update File: ../out.ts', '-a', '+b'].join('\n'), abs(dir, 'sub'), abs(dir, 'sub'))).toEqual([
      { path: abs(dir, 'sub/a.ts') },
      { path: abs(dir, 'sub/gone.ts') },
      { path: abs(dir, 'out.ts') },
    ]);
  });
});

describe('the pipe proof of the security review', () => {
  it('a Claude Code Edit of a named pipe or a UNC path answers at once without opening it', async () => {
    const dir = makeProject({ 'buckets.config.json': '{"buckets":{}}\n' }, false);
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\slopbuckets-hook-test-${process.pid}` : abs(dir, 'hook.sock');
    let opened = 0;
    const server = net.createServer((socket) => {
      opened++;
      socket.write('x');
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      for (const file of [pipe, '\\\\203.0.113.9\\share\\a.ts']) {
        const payload = { session_id: 'poc', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } };
        const io = fakeIo({ cwd: dir, stdin: JSON.stringify(payload), env: { CLAUDE_PROJECT_DIR: dir } });
        expect(await runJson(testContext(), io, claudeAdapter, 'pre-tool-use')).toBe(0);
        expect(io.out).toBe('');
      }
      expect(opened).toBe(0);
    } finally {
      server.close();
    }
  });
});
import { describe, expect, it } from 'vitest';
import { decodeArgs, normalizeHarnessPath, parseHookInput, parsePatch, patchEditedPaths, patchPaths } from './input.js';

const PATCH = [
  '*** Begin Patch',
  '*** Add File: root/log/_/new.ts',
  '+export const x = 1;',
  '+*** Add File: not/a/header.ts',
  '*** Update File: root/_/main.ts',
  '@@',
  '-a',
  '+b',
  '*** Update File: root/_/old.ts',
  '*** Move to: root/_/moved.ts',
  '@@',
  '*** Delete File: buckets.lock.json',
  '*** End Patch',
].join('\n');

describe('patchPaths', () => {
  it('lists every path a patch adds, updates, moves or deletes, in order and without repeats', () => {
    expect(patchPaths(PATCH)).toEqual(['root/log/_/new.ts', 'root/_/main.ts', 'root/_/old.ts', 'root/_/moved.ts', 'buckets.lock.json']);
    expect(patchPaths(`${PATCH}\n*** Update File: root/_/main.ts\n`)).toHaveLength(5);
  });

  it('lists the files that exist after the patch for the post-edit check', () => {
    expect(patchEditedPaths(PATCH)).toEqual(['root/log/_/new.ts', 'root/_/main.ts', 'root/_/moved.ts']);
  });

  it('reads CRLF patches, indented headers and paths with spaces', () => {
    const patch = '*** Begin Patch\r\n  *** Update File: C:\\p\\my file.ts \r\n*** Move to: buckets.lock.json\r\n*** End Patch\r\n';
    expect(parsePatch(patch)).toEqual([{ op: 'update', path: 'C:\\p\\my file.ts', move: 'buckets.lock.json' }]);
    expect(patchPaths(patch)).toContain('buckets.lock.json');
  });

  it('ignores text that is not a patch and empty headers', () => {
    expect(patchPaths('')).toEqual([]);
    expect(patchPaths('echo hi\n*** Add File:\n')).toEqual([]);
    // A move without an update before it still counts as a written path.
    expect(patchPaths('*** Move to: buckets.lock.json')).toEqual(['buckets.lock.json']);
  });
});

describe('normalizeHarnessPath', () => {
  it.each([
    ['/c:/Users/dev/app', 'c:/Users/dev/app'],
    ['/C:\\Users\\dev', 'C:/Users/dev'],
    ['C:\\p\\buckets.lock.json::$DATA', 'C:/p/buckets.lock.json::$DATA'],
    ['\\\\?\\C:\\p\\x', '//?/C:/p/x'],
    ['/p/buckets.lock.json. ', '/p/buckets.lock.json. '],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeHarnessPath(input)).toBe(expected);
  });

  it('turns a file URL into a path', () => {
    expect(normalizeHarnessPath('file:///tmp/x.ts')).toMatch(/tmp[\\/]x\.ts$/);
  });
});

describe('argument decoding', () => {
  it('decodes objects and JSON strings, and anything else as {}', () => {
    expect(decodeArgs({ path: 'a' })).toEqual({ path: 'a' });
    expect(decodeArgs('{"path":"a","command":"ls"}')).toEqual({ path: 'a', command: 'ls' });
    expect(decodeArgs('not json')).toEqual({});
    expect(decodeArgs('[1]')).toEqual({});
    expect(decodeArgs(null)).toEqual({});
    expect(decodeArgs(3)).toEqual({});
  });

  it('parses hook input with a BOM and never throws', () => {
    expect(parseHookInput('\uFEFF{"cwd":"/p"}')).toEqual({ cwd: '/p' });
    expect(parseHookInput('nope')).toEqual({});
    expect(parseHookInput('"text"')).toEqual({});
  });
});

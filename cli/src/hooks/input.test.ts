import { describe, expect, it } from 'vitest';
import { decodeArgs, normalizeHarnessPath, parseHookInput } from './input.js';

describe('normalizeHarnessPath', () => {
  it.each([
    ['/c:/Users/dev/app', 'c:/Users/dev/app'],
    ['/C:\\Users\\dev', 'C:/Users/dev'],
    ['C:\\p\\notes.json::$DATA', 'C:/p/notes.json::$DATA'],
    ['\\\\?\\C:\\p\\x', '//?/C:/p/x'],
    ['/p/notes.json. ', '/p/notes.json. '],
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

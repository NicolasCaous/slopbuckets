// The shared pieces of the shell-command adapters: tool kinds, paths in arguments, patches and the stop mark.
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capText, commandOf, kindOf, pathsIn, stopMemory, toolCall } from './hook-kit.js';

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
});

describe('toolCall', () => {
  it('collects paths under every usual key and from patches in any argument', () => {
    expect(pathsIn({ file_path: 'a', path: 'b', paths: ['c', { path: 'd' }], file_paths: ['a'] })).toEqual(['a', 'b', 'c', 'd']);
    const call = toolCall('write', { path: 'x.ts', extra: '*** Begin Patch\n*** Update File: y.ts\n*** Move to: z.ts\n*** Delete File: w.ts\n*** End Patch' });
    expect(call.action).toEqual({ kind: 'write', paths: ['x.ts', 'y.ts', 'z.ts', 'w.ts'] });
    expect(call.edited).toEqual(['x.ts', 'z.ts']);
  });

  it('treats a view command as a read and a delete as no edit', () => {
    expect(toolCall('write', { command: 'view', path: 'buckets.lock.json' }).action).toEqual({ kind: 'other' });
    expect(toolCall('delete', { file_paths: ['a.ts'] })).toEqual({ action: { kind: 'write', paths: ['a.ts'] }, edited: [] });
  });

  it('reads shell commands as strings or argv arrays, with their folder', () => {
    expect(commandOf({ command: ['bash', '-lc', 'ls'] })).toBe('bash -lc ls');
    expect(toolCall('shell', { command_line: 'ls', dir_path: 'root' }).action).toEqual({ kind: 'shell', command: 'ls', cwd: 'root' });
    expect(toolCall('shell', {}).action).toEqual({ kind: 'other' });
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
    const base = mkdtempSync(path.join(os.tmpdir(), 'sb-mark-'));
    try {
      expect(stopMemory.takeBlocked('k', base)).toBe(false);
      stopMemory.rememberBlocked('k', base);
      expect(stopMemory.takeBlocked('other', base)).toBe(false);
      expect(stopMemory.takeBlocked('k', base)).toBe(true);
      expect(stopMemory.takeBlocked('k', base)).toBe(false);
      stopMemory.rememberBlocked('old', base);
      const file = path.join(base, 'slopbuckets-sessions');
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      for (const name of readdirSync(file)) utimesSync(path.join(file, name), old, old);
      expect(stopMemory.takeBlocked('old', base)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

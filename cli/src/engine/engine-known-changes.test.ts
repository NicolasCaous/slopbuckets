// The inspect snapshot of the engine with known changes, as the inspect server asks for it: it must equal a full one.
import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupProjects, removeFile, writeFile } from '../testing/fixture.js';
import { bucket, engine, project, TSCONFIG } from './engine-test-kit.js';
import { listFiles } from './files.js';

// Counted, so a test can tell a snapshot that took known changes from one that listed every file.
vi.mock('./files.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('./files.js')>();
  return { ...m, listFiles: vi.fn(m.listFiles), readFromGit: vi.fn(m.readFromGit) };
});

afterEach(cleanupProjects);

describe('snapshot with known changes', () => {
  const SUB = ['a', 'b', 'c', 'misc', 'gen', '.hidden'];
  /** A new file for each path the random steps may add: buckets, an unowned folder, a git-ignored one, a dot folder. */
  const POOL = [...SUB.flatMap((s) => [0, 1, 2, 3].map((k) => `src/${s}/f${k}.ts`)), 'nested/src/n/f0.ts', 'nested/src/n/f1.ts', 'nested/src/n/index.ts'];
  const TARGETS = ['../a', '../b', '../c/index', '../a/f1', './f0', './f2', './missing', 'node:fs', '../../src/n'];

  function randomProject(): string {
    const files: Record<string, string> = {
      '.gitignore': '.buckets/\nsrc/gen/\n',
      'src/a/index.ts': "export { v } from './f0';\n",
      'src/a/f0.ts': "import { v as w } from '../b';\nexport const v = w;\n",
      'src/b/index.ts': 'export const v = 1;\n',
      'src/c/index.ts': "import { v } from '../a/f0';\nexport const c = v;\n",
      'src/misc/f0.ts': "import '../b';\n",
      'nested/buckets.config.json': JSON.stringify({ version: '2.0', buckets: { n: bucket('n') } }),
      'nested/tsconfig.json': TSCONFIG,
      'nested/src/n/index.ts': 'export const n = 1;\n',
    };
    const config = { version: '2.0', projects: ['nested'], buckets: { a: bucket('a', { dependsOn: { b: 'Reads b' } }), b: bucket('b'), c: bucket('c') } };
    return project(files, config);
  }

  /** The snapshot a fresh engine makes from a copy of the project without its caches. */
  let copies = 0;
  async function cold(dir: string): Promise<string> {
    // A new folder each time: git makes its objects read-only, which rmSync cannot remove on Windows.
    const copy = `${dir}-cold-${++copies}`;
    cpSync(dir, copy, { recursive: true, filter: (src) => path.basename(src) !== '.buckets' });
    return JSON.stringify(await engine().snapshot(copy));
  }

  it('equals the full snapshot after random adds, edits, deletes and renames', async () => {
    const dir = randomProject();
    const e = engine();
    const first = await e.snapshot(dir);
    expect(first.projects.map((p) => [p.path, p.environment, p.violations.filter((v) => v.rule === 'config-invalid')])).toEqual([
      ['.', null, []],
      ['nested', null, []],
    ]);
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
    const source = (step: number) => {
      const lines = Array.from({ length: Math.floor(rnd() * 3) }, () => `import { v } from '${pick(TARGETS)}';`);
      // The size grows with every step, so the change never hides behind the same mtime and size.
      return `${lines.join('\n')}\nexport const v = ${step};\n// ${'x'.repeat(step)}\n`;
    };
    const existing = () => POOL.filter((f) => existsSync(path.join(dir, f))).concat(['src/a/f0.ts', 'src/b/index.ts', 'src/c/index.ts'].filter((f) => existsSync(path.join(dir, f))));
    const listings = () => vi.mocked(listFiles).mock.calls.length;
    let listed = 0;
    let compared = 0;
    for (let step = 1; step <= 30; step++) {
      const changed: string[] = [];
      for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) {
        const op = pick(['add', 'add', 'edit', 'edit', 'delete', 'rename', 'other'] as const);
        const have = existing();
        const free = POOL.filter((f) => !existsSync(path.join(dir, f)));
        if ((op === 'add' || op === 'rename') && free.length === 0) continue;
        if ((op === 'edit' || op === 'delete' || op === 'rename') && have.length === 0) continue;
        if (op === 'add') {
          const f = pick(free);
          writeFile(dir, f, source(step));
          changed.push(f);
        } else if (op === 'edit') {
          const f = pick(have);
          writeFile(dir, f, source(step));
          changed.push(f);
        } else if (op === 'delete') {
          const f = pick(have);
          removeFile(dir, f);
          changed.push(f);
        } else if (op === 'rename') {
          const [from, to] = [pick(have), pick(free)];
          mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
          renameSync(path.join(dir, from), path.join(dir, to));
          // Either separator and an absolute path both name a file.
          changed.push(from.replace(/\//g, '\\'), path.join(dir, to));
        } else {
          writeFile(dir, 'README.md', `step ${step}\n`);
          changed.push('README.md');
        }
      }
      const before = listings();
      const known = JSON.stringify(await e.snapshot(dir, { changed }));
      listed += listings() - before;
      // A simulated edit in the same engine drops the cache it keeps in memory, while graph.bin may still wait for
      // the write of the last snapshot.
      if (step % 5 === 0) await e.checkEdit(dir, { path: 'src/b/index.ts', content: 'export const v = 2;\n' });
      expect(known, `step ${step}: ${changed.join(', ')}`).toBe(await cold(dir));
      compared++;
    }
    expect(compared).toBe(30);
    // Every snapshot above took the known changes, without listing the files.
    expect(listed).toBe(0);
  }, 120_000);

  it('lists every file when a known change is a folder, a config or a .gitignore', async () => {
    const dir = randomProject();
    const e = engine();
    await e.snapshot(dir);
    const steps: [string, () => void][] = [
      ['src/moved', () => renameSync(path.join(dir, 'src/c'), path.join(dir, 'src/moved'))],
      ['.gitignore', () => writeFile(dir, '.gitignore', '.buckets/\n')],
      ['tsconfig.json', () => writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: {} } }))],
    ];
    for (const [changed, act] of steps) {
      act();
      const listings = vi.mocked(listFiles).mock.calls.length;
      const known = JSON.stringify(await e.snapshot(dir, { changed: [changed] }));
      expect(vi.mocked(listFiles).mock.calls.length, changed).toBe(listings + 1);
      expect(known, changed).toBe(await cold(dir));
    }
  });
});

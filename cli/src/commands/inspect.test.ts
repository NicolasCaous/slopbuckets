import { linkSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SnapshotV2 } from '../contract/snapshot.js';
import { exportMermaid } from '../inspect/node/export.js';
import { createFakeEngine } from '../testing/fake-engine.js';
import { makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { httpRequest } from '../testing/http.js';
import { inspectCommand, inspectOptions } from './inspect.js';

const fixtures = fileURLToPath(new URL('../../../examples/fixtures/snapshots/', import.meta.url));
const small = JSON.parse(readFileSync(path.join(fixtures, 'small.json'), 'utf8')) as SnapshotV2;

function setup(files: Record<string, string> = {}) {
  const dir = makeProject({ 'page/inspect-page.js': 'window.stub = 1;', ...files });
  const ctx = { ...testContext(), engine: createFakeEngine({ snapshot: small }) };
  return { dir, ctx, io: fakeIo({ cwd: dir }), deps: { pageDir: path.join(dir, 'page'), watch: false } };
}

describe('inspect arguments', () => {
  it.each([
    [['--export'], '--export needs a value'],
    [['--export', 'png'], 'not "png"'],
    [['--export=pdf'], 'not "pdf"'],
    [['--out', 'a.txt'], '--out only works with --export'],
    [['--export', 'dot', '--out'], '--out needs a value'],
    [['--export', 'dot', '--out='], '--out needs a file path'],
    [['--json', '--export', 'dot'], 'do not go together'],
    [['--file', 'x'], 'unknown option "--file"'],
    [['extra'], 'unexpected argument "extra"'],
  ])('rejects %j with the usage exit code', async (args, message) => {
    const { ctx, io, deps } = setup();
    expect(await inspectCommand(ctx, io, args, deps)).toBe(64);
    expect(io.err).toContain(message);
    expect(io.err).toContain('Usage: buckets inspect');
  });

  it('reads every option', () => {
    expect(inspectOptions({ 'no-recursive': true, export: 'dot', out: 'g.dot' })).toEqual({ json: false, recursive: false, format: 'dot', out: 'g.dot' });
  });
});

describe('inspectCommand', () => {

  it('prints the snapshot with --json, only the root project with --no-recursive', async () => {
    const { ctx, io, deps } = setup();
    expect(await inspectCommand(ctx, io, ['--json'], deps)).toBe(0);
    expect(JSON.parse(io.out)).toEqual(small);
    const second = setup();
    expect(await inspectCommand(second.ctx, second.io, ['--json', '--no-recursive'], second.deps)).toBe(0);
    expect((JSON.parse(second.io.out) as SnapshotV2).projects.map((p) => p.path)).toEqual(['.']);
  });

  it('exits with 3 without a config', async () => {
    const dir = makeProject({}, false);
    const io = fakeIo({ cwd: dir });
    // The temporary folders live inside the repository, which has no buckets.config.json above them.
    expect(await inspectCommand(testContext(), io, ['--json'])).toBe(3);
    expect(io.err).toContain('No buckets.config.json');
  });

  it('writes the mermaid export to --out and refuses a hard link', async () => {
    const { dir, ctx, io, deps } = setup({ 'old.mmd': 'old' });
    expect(await inspectCommand(ctx, io, ['--export', 'mermaid', '--out', 'graph.mmd'], deps)).toBe(0);
    expect(readFileSync(path.join(dir, 'graph.mmd'), 'utf8')).toBe(exportMermaid(small, path.basename(dir)));
    expect(io.out).toContain('Wrote the mermaid export to');
    linkSync(path.join(dir, 'old.mmd'), path.join(dir, 'linked.mmd'));
    expect(await inspectCommand(ctx, io, ['--export', 'dot', '--out', 'linked.mmd'], deps)).toBe(1);
    expect(io.err).toContain('hard links');
    expect(readFileSync(path.join(dir, 'old.mmd'), 'utf8')).toBe('old');
  });

  it('prints the html export with the snapshot and the inlined bundle', async () => {
    const { ctx, io, deps } = setup();
    expect(await inspectCommand(ctx, io, ['--export', 'html'], deps)).toBe(0);
    expect(io.out).toContain('<script>window.stub = 1;</script>');
    expect(io.out).toContain('<script type="application/json" id="snapshot">');
  });

  it('exits with 3 when the page bundle is missing', async () => {
    const { ctx, io, dir } = setup();
    expect(await inspectCommand(ctx, io, ['--export', 'html'], { pageDir: path.join(dir, 'nothing') })).toBe(3);
    expect(io.err).toContain('the inspect page bundle is missing');
  });

  it('starts the server, prints the URL and stops', async () => {
    const { ctx, io, deps } = setup();
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let snapshotBody = '';
    const code = await inspectCommand(ctx, io, [], {
      ...deps,
      stop: stopped,
      onListening: (app) => {
        void httpRequest(app.server.port, { path: '/snapshot.json' }).then((res) => {
          snapshotBody = res.body;
          stop();
        });
      },
    });
    expect(code).toBe(0);
    expect(io.out).toMatch(/http:\/\/127\.0\.0\.1:\d+\//);
    expect(JSON.parse(snapshotBody)).toEqual(small);
  });

  it('keeps an existing regular file writable', async () => {
    const { dir, ctx, io, deps } = setup();
    writeFileSync(path.join(dir, 'g.dot'), 'old');
    expect(await inspectCommand(ctx, io, ['--export', 'dot', '--out', 'g.dot'], deps)).toBe(0);
    expect(readFileSync(path.join(dir, 'g.dot'), 'utf8')).toContain('digraph buckets');
  });
});

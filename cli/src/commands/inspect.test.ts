import { linkSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { helpText, main } from '../cli.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { httpRequest } from '../testing/http.js';
import type { InspectApp } from '../web/inspect-app.js';
import { runsForbiddenRefresh, touchesLock } from './hook.js';
import { INSPECT_USAGE, inspectCommand, outProblem } from './inspect.js';

afterEach(cleanupProjects);

describe('buckets inspect --json', () => {
  it('prints the snapshot and exits 0 without a server', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['inspect', '--json'])).toBe(0);
    const snapshot = JSON.parse(io.out);
    expect(Object.keys(snapshot)).toEqual(['snapshotVersion', 'cli', 'generatedAt', 'dir', 'exitCode', 'summary', 'projects', 'links']);
    expect(Object.keys(snapshot.projects[0])).toEqual([
      'path', 'name', 'dir', 'parent', 'container', 'exitCode', 'status', 'config', 'lock', 'buckets', 'contracts', 'imports', 'cycles', 'orphans', 'violations', 'lockChanges', 'links', 'external', 'nested',
    ]);
    expect(snapshot.projects[0].contracts[0].symbols[0]).toMatchObject({ name: 'logger', origin: 'root/log', chain: ['root/billing/dmz/.parent/invoices.ts', 'root/dmz/log/billing.ts', 'root/log/_/logger.ts'] });
    expect(io.err).toBe('');
  });

  it('prints violations and exits 0, because the snapshot is the answer', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'root/log/_/bad.ts': "import x from './x';\nexport const bad = x;\n" });
    const io = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), io, ['--json'])).toBe(0);
    expect(JSON.parse(io.out).exitCode).toBe(1);
  });

  it('starts from the nearest project above the current folder', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: `${dir}/root/log/_` });
    expect(await inspectCommand(testContext(), io, ['--json'])).toBe(0);
    expect(JSON.parse(io.out).dir).toBe(dir);
  });

  it('refuses unknown options and folders outside a project', async () => {
    const dir = makeProject({}, false);
    const io = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), io, ['--web'])).toBe(1);
    expect(io.err).toContain('unknown option "--web"');
    const outside = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), outside, ['--json'])).toBe(3);
    expect(outside.err).toContain('No buckets.config.json');
  });
});

describe('buckets inspect', () => {
  it('prints the URL last, serves the page and stops when asked', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const io = fakeIo({ cwd: dir });
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    let app!: InspectApp;
    const listening = new Promise<void>((resolve) => {
      void inspectCommand(testContext(), io, [], { watch: false, stop: stopped, onListening: (a) => { app = a; resolve(); } }).then((code) => expect(code).toBe(0));
    });
    await listening;
    const lines = io.out.trim().split('\n');
    expect(lines[lines.length - 1]).toBe(app.server.url);
    expect(io.out).toContain('Press Ctrl+C to stop');
    expect((await httpRequest(app.server.port)).status).toBe(200);
    stop();
    await app.server.closed;
  });

  it('is listed in the help and allowed by the lock hook', () => {
    const help = helpText('1.0.0');
    expect(help).toContain('inspect --json');
    expect(help).toMatch(/\n {2}inspect {2,}/);
    expect(runsForbiddenRefresh('buckets inspect')).toBe(false);
    expect(runsForbiddenRefresh('buckets inspect --json')).toBe(false);
    expect(touchesLock({ tool_name: 'Bash', tool_input: { command: 'buckets inspect --json' } })).toBe(false);
  });
});

describe('buckets inspect --export', () => {
  it('prints the bucket graph as Mermaid to stdout without a server and without writing to the project', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const before = readdirSync(dir).sort();
    const io = fakeIo({ cwd: dir });
    expect(await main(testContext(), io, ['inspect', '--export', 'mermaid'])).toBe(0);
    expect(io.out.startsWith('flowchart TB')).toBe(true);
    expect(io.out).toContain('subgraph P0["fixture (repo)"]');
    expect(io.out).toMatch(/P0_B\d+_d -->\|"1 symbol"\| P0_B\d+_c/);
    expect(io.err).toBe('');
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('writes the map as SVG to the file --out names, and prints JSON with --json', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const outDir = makeProject({}, false);
    const io = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), io, ['--export=svg', '--out', path.join(outDir, 'map.svg')])).toBe(0);
    expect(readFileSync(path.join(outDir, 'map.svg'), 'utf8')).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(io.out).toBe(`Wrote the map as SVG to ${path.join(outDir, 'map.svg')}.\n`);
    const json = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), json, ['--export', 'mermaid', '--json'])).toBe(0);
    const parsed = JSON.parse(json.out);
    expect(parsed).toMatchObject({ format: 'mermaid', file: null });
    expect(parsed.nodes.map((n: { label: string }) => n.label)).toContain('dmz/ .parent');
    expect(parsed.edges).toContainEqual(expect.objectContaining({ kind: 'down', file: 'root/billing/dmz/.parent/invoices.ts', label: '1 symbol' }));
    expect(parsed.text.startsWith('flowchart TB')).toBe(true);
  });

  it('refuses a missing or unknown format, --out without --export, and a lock file as --out, also through a link', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    await approve(dir);
    const lock = readFileSync(path.join(dir, 'buckets.lock.json'), 'utf8');
    const run = async (args: string[]) => {
      const io = fakeIo({ cwd: dir });
      return { code: await inspectCommand(testContext(), io, args), err: io.err };
    };
    expect(await run(['--export'])).toMatchObject({ code: 1, err: expect.stringContaining('--export needs a format: svg, mermaid or html') });
    expect(await run(['--export', 'png'])).toMatchObject({ code: 1, err: expect.stringContaining('not "png"') });
    expect(await run(['--out', 'x.svg'])).toMatchObject({ code: 1, err: expect.stringContaining('--out only works with --export') });
    expect(await run(['--export', 'svg', '--out', 'buckets.lock.json'])).toMatchObject({ code: 1, err: expect.stringContaining('Only an approval writes buckets.lock.json') });
    expect(await run(['--export', 'svg', '--out', 'root'])).toMatchObject({ code: 1, err: expect.stringContaining('is a folder') });
    let linked = false;
    try {
      symlinkSync(path.join(dir, 'buckets.lock.json'), path.join(dir, 'map.svg'), 'file');
      linked = true;
    } catch {
      // Creating a file symlink needs a privilege on Windows; the name check above still applies.
    }
    if (linked) expect(await run(['--export', 'svg', '--out', 'map.svg'])).toMatchObject({ code: 1, err: expect.stringContaining('points to a lock file') });
    // A hard link has no target path to resolve, and writing through it writes the lock itself.
    linkSync(path.join(dir, 'buckets.lock.json'), path.join(dir, 'hard.json'));
    expect(await run(['--export', 'svg', '--out', 'hard.json'])).toMatchObject({ code: 1, err: expect.stringContaining('other hard links') });
    expect(readFileSync(path.join(dir, 'buckets.lock.json'), 'utf8')).toBe(lock);
    expect(outProblem(path.join(dir, 'BUCKETS.LOCK.JSON'))).toContain('is a lock file');
  });

  it('is listed in the help and the usage', () => {
    expect(helpText('1.0.0')).toContain('inspect --export <format>');
    expect(INSPECT_USAGE).toContain('--export svg|mermaid|html [--out <file>]');
  });
});

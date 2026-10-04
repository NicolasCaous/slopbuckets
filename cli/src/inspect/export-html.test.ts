import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectCommand } from '../commands/inspect.js';
import { linkCommand } from '../commands/link.js';
import type { Lock } from '../core/types.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { VIEWS } from '../web/inspect-page.js';
import { hashHref, hashLinks, internalUrl, packStaticData, STATIC_DATA_ID, staticDocument, unpackStaticData, type StaticData, type StaticFileData } from '../web/inspect-static.js';
import { exportHtml, staticBundle, staticData } from './export-html.js';
import { buildSnapshot, type InspectSnapshot } from './snapshot.js';
import type { GitRunner, Timeline } from './timeline.js';

const NESTED = 'root/log/_/engine';

/** Git that is not installed: the file then has no timeline. */
const noGit: GitRunner = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', stderr: '' }));

function lock(buckets: string[], dmz: Record<string, string[]>): Lock {
  const out: Lock = { lockVersion: 3, cli: '1.0.0', adapter: { name: 'fake', version: '1.0.0' }, config: 'sha256:c', buckets, dmz: {} };
  for (const [file, symbols] of Object.entries(dmz)) out.dmz[file] = { text: `sha256:${file}`, symbols: Object.fromEntries(symbols.map((s) => [s, `sha256:${s}`])) };
  return out;
}

const V1 = lock(['root', 'root/log', 'root/billing'], { 'root/dmz/log/billing.ts': ['logger'] });
const V2 = lock(['root', 'root/log', 'root/billing', 'root/billing/invoices'], { 'root/dmz/log/billing.ts': ['logger', 'level'], 'root/billing/dmz/.parent/invoices.ts': ['logger'] });
const V3 = lock(['root', 'root/log', 'root/billing', 'root/billing/invoices'], { 'root/dmz/log/billing.ts': ['logger', 'level'], 'root/billing/dmz/.parent/invoices.ts': ['logger', 'level'] });

const point = (id: string, date: string, subject: string, l: Lock | null) => ({ id, short: id.slice(0, 7), date, author: 'Ana Lima', subject, file: 'buckets.lock.json', state: l ? ('ok' as const) : ('deleted' as const), lock: l });

const TIMELINE: Timeline = {
  tracks: [
    {
      project: '.',
      name: 'fixture',
      status: 'ok',
      truncated: false,
      repo: null,
      points: [
        point('a1a1a1a1a1a1a1a1', '2026-09-01T10:00:00Z', 'Approve log and billing', V1),
        point('b2b2b2b2b2b2b2b2', '2026-09-02T10:00:00Z', 'Remove the lock', null),
        point('c3c3c3c3c3c3c3c3', '2026-09-03T10:00:00Z', 'Approve invoices', V2),
        point('d4d4d4d4d4d4d4d4', '2026-09-04T10:00:00Z', 'Approve level', V3),
      ],
    },
  ],
};

let dir: string;
let snapshot: InspectSnapshot;
let data: StaticData;
let bundle: string;
let page: string;

beforeAll(async () => {
  dir = makeProject({
    ...LOGGER_PROJECT,
    'package.json': JSON.stringify({ name: 'shop' }),
    [`${NESTED}/buckets.config.json`]: '{ "root": "root", "alias": "@engine" }\n',
    [`${NESTED}/package.json`]: '{ "name": "engine" }\n',
    [`${NESTED}/root/_/run.ts`]: 'export const run = 1;\n',
    [`${NESTED}/root/core/_/engine.ts`]: 'export interface Engine {\n  name: string;\n}\n',
    [`${NESTED}/root/dmz/core/.external.ts`]: "export type { Engine } from '@engine/core/_/engine';\n",
    'root/web/_/app.ts': "import type { Engine } from '@engine/dmz/core/.external';\nexport const name = (e: Engine): string => e.name;\n",
  });
  await linkCommand(testContext(), fakeIo({ cwd: dir }), ['add', 'engine', NESTED, '--bucket', 'root/web', '--copy']);
  await approve(dir);
  await approve(path.join(dir, NESTED));
  writeFile(dir, 'root/log/_/logger.ts', 'export function logger(message: string, level: number): void {}\n');
  writeFile(dir, 'root/dmz/log/web.ts', "export { logger } from '@root/log/_/logger';\n");
  writeFile(dir, 'root/billing/payments/_/pay.ts', "import { billing } from '@root/billing/_/billing.module';\nexport const pay = billing;\n");
  snapshot = await buildSnapshot(testContext(), dir, { now: new Date('2026-10-04T12:00:00.000Z') });
  data = { ...(await staticData(snapshot, noGit)), timeline: TIMELINE, info: { takenAt: snapshot.generatedAt, cli: '1.0.0', hidden: [] } };
  bundle = await staticBundle();
  page = await exportHtml(snapshot, { git: noGit, bundle });
}, 60_000);
afterAll(cleanupProjects);

/** The text of each inline element of a kind, in order. */
function inline(text: string, tag: 'script' | 'style'): string[] {
  return [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!);
}

/** The page without the code of its inline scripts, which mentions live URLs it never uses in the file. */
function markup(text: string): string {
  return text.replace(/<script>[\s\S]*?<\/script>/g, '<script></script>');
}

function embedded(text: string): StaticFileData {
  const m = new RegExp(`<script type="application/json" id="${STATIC_DATA_ID}">([\\s\\S]*?)</script>`).exec(text);
  return JSON.parse(m![1]!) as StaticFileData;
}

describe('the HTML file', () => {
  it('embeds the snapshot without the folders of this computer', () => {
    const file = embedded(page);
    expect(file.snapshot.summary).toEqual(snapshot.summary);
    expect(file.snapshot.projects.map((p) => [p.path, p.dir])).toEqual(snapshot.projects.map((p) => [p.path, p.path]));
    expect(page).not.toContain(dir);
    expect(page).not.toContain(dir.replace(/\\/g, '\\\\'));
    expect(file.info).toEqual({ takenAt: '2026-10-04T12:00:00.000Z', cli: expect.any(String), hidden: ['timeline'] });
    expect(page).toContain('Static snapshot of <strong translate="no">shop</strong> taken <time datetime="2026-10-04T12:00:00.000Z" data-when>2026-10-04 12:00 UTC</time> by <span translate="no">buckets ');
  });

  it('carries the exports of every _/ folder for the path simulation', () => {
    const file = embedded(page);
    expect(file.exports['.']!['root/log/_/logger.ts']).toEqual(['logger']);
    expect(Object.keys(file.exports)).toEqual(snapshot.projects.map((p) => p.path));
  });

  it('allows only its own inline scripts and styles, the fonts, and no requests', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)![1]!.replace(/&#39;/g, "'");
    const hash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
    const scripts = inline(page, 'script');
    expect(scripts).toHaveLength(3);
    expect(scripts[1]).toBe(bundle);
    expect(csp).toContain(`script-src ${scripts.map(hash).join(' ')};`);
    expect(csp).toContain(`style-src ${inline(page, 'style').map(hash).join(' ')} https://fonts.googleapis.com;`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('unsafe');
    // Nothing loads from a server: the stylesheets and scripts are inline and the icon is a data URL.
    expect(page).not.toMatch(/<script [^>]*src=|<link rel="stylesheet" href="\//);
    expect(markup(page)).not.toContain('/assets/');
    expect(markup(page)).not.toContain('buckets-token');
  });

  it('links between views with the URL hash', () => {
    expect(page).toContain('<a href="#view=matrix"><span class="n" aria-hidden="true">1:</span>matrix</a>');
    expect(markup(page)).not.toMatch(/ href="\/(\?|")/);
    // The timeline has no window: there is no git history.
    expect(page).not.toMatch(/>timeline<\/a>/);
    expect(page).toContain('[static snapshot]');
    expect(page).toContain('Exported by <code translate="no">buckets inspect --export html</code>');
  });
});

describe('pages rendered from the hash', () => {
  it('turns hash links and live links into the same URL', () => {
    expect(internalUrl('#view=matrix&bucket=root%2Flog')).toBe('/?view=matrix&bucket=root%2Flog');
    expect(internalUrl('#')).toBe('/');
    expect(internalUrl('')).toBe('/');
    expect(internalUrl('/?view=trace')).toBe('/?view=trace');
    expect(hashHref('/?view=trace')).toBe('#view=trace');
    expect(hashHref('/')).toBe('#');
    expect(hashHref('/export/buckets.mmd')).toBe('/export/buckets.mmd');
    expect(hashLinks('<a href="/">x</a><a href="/?a=1&amp;b=2">y</a><a href="/export/map.svg">z</a><a href="#main">w</a>')).toBe('<a href="#">x</a><a href="#a=1&amp;b=2">y</a><a href="/export/map.svg">z</a><a href="#main">w</a>');
  });

  it('renders every view, with the window of that view current and hash links only', () => {
    for (const view of VIEWS) {
      const doc = staticDocument(data, view === 'map' ? '#' : `#view=${view}`);
      expect(doc, view).toContain(`<div class="inspect" id="app" data-view="${view}" data-project="."`);
      expect(doc, view).toMatch(new RegExp(`<a href="#[^"]*" aria-current="page"><span class="n" aria-hidden="true">\\d:</span>${view}`));
      expect(doc, view).not.toMatch(/ href="\/(\?|")/);
      expect(doc, view).toContain('<span id="server-status"><span class="label">snapshot, ');
    }
  });

  it('renders selections: a bucket, a contract, a symbol, a link, a nested project and a layout', () => {
    expect(staticDocument(data, '#bucket=root%2Flog')).toContain('id="panel"');
    expect(staticDocument(data, '#bucket=root%2Flog')).toContain('<h2 class="panel-title" id="panel-title"><span translate="no">log</span></h2>');
    expect(staticDocument(data, '#view=matrix&cell=root%2Fdmz%2Flog%2Fweb.ts')).toContain('root/dmz/log/web.ts');
    expect(staticDocument(data, '#view=trace&symbol=logger&of=root%2Flog%2F_%2Flogger.ts')).toContain('logger');
    expect(staticDocument(data, '#view=projects&link=root%2Fweb%2F_%2Flinks%2Fengine')).toContain('engine');
    expect(staticDocument(data, `#project=${encodeURIComponent(NESTED)}`)).toContain(`data-project="${NESTED}"`);
    expect(staticDocument(data, '#layout=all')).toContain('<div class="inspect" id="app" data-view="map"');
  });

  it('runs the impact simulations from the data, the path simulation with the exports of the file', () => {
    expect(staticDocument(data, '#view=impact&sim=bucket&bucket=root%2Flog')).toContain('data-view="impact"');
    const route = staticDocument(data, '#view=impact&sim=path');
    expect(route).toContain('root/log/_/logger.ts::logger');
  });

  it('shows the approvals embedded at export time on the timeline', () => {
    const newest = staticDocument(data, '#view=timeline');
    expect(newest).toContain('Approve level');
    expect(newest).toContain('id="tl-data"');
    const first = staticDocument(data, '#view=timeline&at=a1a1a1a1a1a1a1a1');
    expect(first).toContain('Approve log and billing');
  });
});

describe('the timeline in the file', () => {
  it('keeps only what changed between approvals and restores every lock', () => {
    const packed = packStaticData(data);
    const points = packed.timeline!.tracks[0]!.points;
    expect(points[0]!.lock).toEqual(V1);
    expect(points[1]!.lock).toBeNull();
    const third = points[3]!.lock as unknown as { buckets: unknown; dmz: Record<string, unknown> };
    expect(third.buckets).toBe(0);
    expect(third.dmz['root/dmz/log/billing.ts']).toBe(0);
    expect(third.dmz['root/billing/dmz/.parent/invoices.ts']).toEqual(V3.dmz['root/billing/dmz/.parent/invoices.ts']);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(data).length);
    expect(unpackStaticData(JSON.parse(JSON.stringify(packed)) as StaticFileData).timeline).toEqual(TIMELINE);
  });
});

describe('the browser script', () => {
  it('renders every page in the browser without a request or evaluating text', () => {
    const fetches: unknown[] = [];
    const file = packStaticData(data);
    const sandbox: Record<string, unknown> = {
      document: { getElementById: (id: string) => (id === STATIC_DATA_ID ? { textContent: JSON.stringify(file) } : null) },
      fetch: (...args: unknown[]) => {
        fetches.push(args);
        throw new Error('no requests');
      },
      XMLHttpRequest: function XMLHttpRequest() {
        fetches.push('xhr');
      },
      Function: () => {
        throw new Error('evaluating text is not allowed');
      },
      TextEncoder,
      URL,
      URLSearchParams,
    };
    sandbox.window = sandbox;
    runInNewContext(bundle, sandbox);
    const app = sandbox.bucketsStatic as { page(url: string): string; file(link: string): { name: string; type: string; text: string } | null };
    for (const view of VIEWS) expect(app.page(`#view=${view}`)).toContain(`data-view="${view}"`);
    expect(app.page('#view=timeline&at=c3c3c3c3c3c3c3c3')).toContain('Approve invoices');
    expect(app.page('#view=impact&sim=path')).toContain('root/log/_/logger.ts::logger');
    expect(app.page('#view=matrix')).toBe(staticDocument(data, '#view=matrix'));
    const svg = app.file('/export/map.svg')!;
    expect(svg.name).toBe('shop-map.svg');
    expect(svg.text.startsWith('<svg')).toBe(true);
    expect(app.file('/export/buckets.mmd')!.text.startsWith('flowchart TB')).toBe(true);
    expect(fetches).toEqual([]);
  });
});

describe('buckets inspect --export html', () => {
  it('writes the file with --out, reports its size with --json, and refuses a lock file', async () => {
    const outDir = makeProject({}, false);
    const out = path.join(outDir, 'inspect.html');
    const io = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), io, ['--export', 'html', '--out', out], { git: noGit })).toBe(0);
    expect(io.out).toBe(`Wrote the inspect page as one HTML file to ${out}.\n`);
    expect(readFileSync(out, 'utf8')).toMatch(/^<!doctype html>/);
    const json = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), json, ['--export=html', '--json'], { git: noGit })).toBe(0);
    const parsed = JSON.parse(json.out) as { format: string; file: null; bytes: number; text: string };
    expect(parsed).toMatchObject({ format: 'html', file: null });
    expect(parsed.bytes).toBe(Buffer.byteLength(parsed.text, 'utf8'));
    const lockBefore = readFileSync(path.join(dir, 'buckets.lock.json'), 'utf8');
    const refused = fakeIo({ cwd: dir });
    expect(await inspectCommand(testContext(), refused, ['--export', 'html', '--out', 'buckets.lock.json'], { git: noGit })).toBe(1);
    expect(refused.err).toContain('Only an approval writes buckets.lock.json');
    expect(readFileSync(path.join(dir, 'buckets.lock.json'), 'utf8')).toBe(lockBefore);
  }, 60_000);
});

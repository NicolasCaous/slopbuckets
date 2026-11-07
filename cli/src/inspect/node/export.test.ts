import { linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SnapshotV2 } from '../../contract/snapshot.js';
import { makeProject } from '../../testing/fixture.js';
import { exportDot, exportMermaid, mermaidLabel, outProblem, publicText } from './export.js';
import { embedJson, pageHtml } from './page.js';

const fixtures = fileURLToPath(new URL('../../../../examples/fixtures/snapshots/', import.meta.url));
const load = (name: string): SnapshotV2 => JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), 'utf8')) as SnapshotV2;

describe('exportMermaid and exportDot', () => {
  it('match the golden files for the small fixture', async () => {
    const small = load('small');
    await expect(exportMermaid(small)).toMatchFileSnapshot('./golden/small.mmd');
    await expect(exportDot(small)).toMatchFileSnapshot('./golden/small.dot');
  });

  it('keep names and reasons with special characters out of the syntax', () => {
    const snapshot = load('small');
    const project = snapshot.projects[0]!;
    project.edges[0] = { ...project.edges[0]!, reason: 'Says "hi" <b>#1</b>\nand \\ more' };
    const mermaid = exportMermaid(snapshot);
    expect(mermaid).toContain(mermaidLabel('Says "hi" <b>#1</b> and \\ more'));
    expect(mermaid).not.toContain('<b>');
    expect(exportDot(snapshot)).toContain('label="Says \\"hi\\" <b>#1</b> and \\\\ more"');
  });
});

describe('root name and public files', () => {
  it('name the root project by its folder and carry every public file', () => {
    const snapshot = load('small');
    const b = snapshot.projects[0]!.buckets.find((x) => x.public.length > 0)!;
    b.public.push({ file: 'src/second.ts', exists: true, exports: [] });
    expect(publicText(b)).toBe(`public: ${b.public[0]!.file}, src/second.ts`);
    expect(publicText({ ...b, public: [] })).toBe('closed, no public file');
    const mermaid = exportMermaid(snapshot, 'shop');
    expect(mermaid).toContain('subgraph p0["shop"]');
    expect(mermaid).toContain(`%% ${b.name} public: ${b.public[0]!.file}, src/second.ts`);
    const dot = exportDot(snapshot, 'shop');
    expect(dot).toContain('label="shop";');
    expect(dot).toContain(`tooltip="public: ${b.public[0]!.file}, src/second.ts"`);
  });

  it('puts the root name into the title and #app, escaped', () => {
    const page = pageHtml({ script: '', css: null }, undefined, 'a"<b>');
    expect(page).toContain('<title>a&#34;&#60;b&#62;: buckets inspect</title>');
    expect(page).toContain('<div id="app" data-root="a&#34;&#60;b&#62;"></div>');
  });
});
describe('pageHtml', () => {
  const assets = { script: 'window.stub = "</script>";', css: 'body { color: red }' };

  it('links the bundle and the CSS when served', () => {
    const page = pageHtml(assets);
    expect(page).toContain('<script src="/inspect-page.js"></script>');
    expect(page).toContain('<link rel="stylesheet" href="/inspect-page.css">');
    expect(page).not.toContain('id="snapshot"');
  });

  it('gives each color scheme a theme color equal to the page background', () => {
    const css = readFileSync(new URL('../page/inspect.css', import.meta.url), 'utf8');
    const backgrounds = [...css.matchAll(/--bg: (#[0-9a-f]{6});/g)].map((m) => m[1]);
    const page = pageHtml(assets);
    expect(page).toContain('<meta name="color-scheme" content="light dark">');
    expect(page).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${backgrounds[0]}">`);
    expect(page).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${backgrounds[1]}">`);
  });

  it('inlines the bundle and embeds the snapshot for the offline export', () => {
    const snapshot = load('small');
    snapshot.projects[0]!.buckets[0]!.purpose = 'ends with </script><script>alert(1)</script>';
    const page = pageHtml(assets, snapshot);
    const embedded = /<script type="application\/json" id="snapshot">(.*?)<\/script>/s.exec(page)?.[1];
    expect(embedded).toBe(embedJson(snapshot));
    expect(JSON.parse(embedded!)).toEqual(snapshot);
    expect(page).toContain('<script>window.stub = "<\\/script>";</script>');
    expect(page).toContain('<style>body { color: red }</style>');
    expect(page).toContain("default-src 'none'");
    expect(page).not.toContain('src="/inspect-page.js"');
  });
});

describe('outProblem', () => {
  it('allows a new file and a regular file', () => {
    const dir = makeProject({ 'old.txt': 'x' });
    expect(outProblem(path.join(dir, 'new.txt'))).toBeNull();
    expect(outProblem(path.join(dir, 'old.txt'))).toBeNull();
  });

  it('refuses a folder and a hard link', () => {
    const dir = makeProject({ 'a.txt': 'x' });
    mkdirSync(path.join(dir, 'folder'));
    expect(outProblem(path.join(dir, 'folder'))).toContain('not a regular file');
    linkSync(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));
    expect(outProblem(path.join(dir, 'b.txt'))).toContain('hard links');
    writeFileSync(path.join(dir, 'c.txt'), 'y');
    expect(outProblem(path.join(dir, 'c.txt'))).toBeNull();
  });
});

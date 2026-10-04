import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkCommand } from '../commands/link.js';
import { cleanupProjects, LOGGER_PROJECT, makeProject, writeFile } from '../testing/fixture.js';
import { approve, fakeIo, testContext } from '../testing/harness.js';
import { mermaidLabel } from './export-mermaid.js';
import { exportFileName, exportMermaid, exportSvg, exportText } from './export.js';
import { mapCore, renderMapSvg } from './map-svg.js';
import { buildSnapshot, type InspectSnapshot } from './snapshot.js';

const NESTED = 'root/log/_/engine';

/** A cycle, an orphan, a forbidden import, a lock difference, a nested project and a link. */
async function project(): Promise<string> {
  const dir = makeProject({
    ...LOGGER_PROJECT,
    'package.json': JSON.stringify({ name: '@acme/shop "x"' }),
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
  writeFile(dir, 'root/billing/dmz/payments/invoices.ts', "export { pay } from '@root/billing/payments/_/pay';\n");
  writeFile(dir, 'root/billing/invoices/_/use.ts', "import { pay } from '@root/billing/dmz/payments/invoices';\nexport const used = pay;\n");
  writeFile(dir, 'root/billing/dmz/invoices/payments.ts', "export { create } from '@root/billing/invoices/_/create-invoice';\n");
  writeFile(dir, 'root/billing/invoices/_/create-invoice.ts', "import { logger } from '@root/billing/dmz/.parent/invoices';\nlogger('created');\nexport const create = 1;\n");
  writeFile(dir, 'root/billing/payments/_/charge.ts', "import { create } from '@root/billing/dmz/invoices/payments';\nexport const charge = create;\n");
  return dir;
}

let snapshot: InspectSnapshot;
beforeAll(async () => {
  snapshot = await buildSnapshot(testContext(), await project(), { now: new Date('2026-10-04T12:00:00.000Z') });
});
afterAll(cleanupProjects);

/** True when every element of an XML text is closed in order. Enough to catch broken markup in a test. */
function wellFormed(text: string): boolean {
  const stack: string[] = [];
  for (const m of text.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m as unknown as [string, string, string, string, string];
    if (self === '/') continue;
    if (close === '/') {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0 && !/<(?![a-zA-Z/!?])/.test(text);
}

describe('map as SVG', () => {
  it('draws the page layout as a standalone file with walls, labels, violations and a legend', () => {
    const svg = exportSvg(snapshot);
    expect(svg.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(wellFormed(svg.svg)).toBe(true);
    expect(svg.width).toBe(1200);
    expect(svg.svg).toContain('slopbuckets map of @acme/shop &#34;x&#34;: 6 buckets, 5 contracts, 4 violations');
    for (const name of ['root/', 'log/', 'billing/', 'invoices/', 'payments/', 'web/']) expect(svg.svg).toContain(`>${name}<`);
    expect(svg.svg).toContain('>cycle<');
    expect(svg.svg).toContain('>import-forbidden<');
    expect(svg.svg).toContain('>orphan logger<');
    expect(svg.svg).toContain('>forbidden import<');
    expect(svg.svg).not.toMatch(/<style|style="|<script|@import|url\(http/);
    expect(svg.svg).toContain('font-family="ui-monospace, Menlo, Consolas, &#34;DejaVu Sans Mono&#34;, monospace"');
  });

  it('matches the snapshot of the fixture', () => {
    expect(exportSvg(snapshot).svg).toMatchSnapshot();
  });

  it('uses the same layout as the page script, evaluated on the server', () => {
    const core = mapCore();
    expect(core.SIT).toMatchObject({ ok: '#3dff74', lock: '#ffc04d', violation: '#ff6e61' });
    const data = { project: '.', name: 'x', root: 'root', situation: 'ok' as const, selected: null, highlight: null, overlays: { cycles: [], orphans: [], forbidden: [] }, buckets: [{ path: 'root', name: 'root', level: 0, parent: null, children: [], files: 2, situation: 'ok' as const, violations: 0, lockChanges: 0, contracts: 0, symbols: 0, dmz: 'ok' as const, projects: [], dependsOn: [], dependents: [] }] };
    const small = renderMapSvg(data, { standalone: false, cols: 40, idPrefix: 'p' });
    expect(small.svg.startsWith('<svg class="map-svg"')).toBe(true);
    expect(small.width).toBe(320);
    expect(small.svg).toContain('id="p-glow"');
    expect(wellFormed(small.svg)).toBe(true);
  });

  it('draws a short note for a project the check could not run on, and names the file after the project', async () => {
    const dir = makeProject(LOGGER_PROJECT);
    const broken = await buildSnapshot(testContext({ analyzeError: new Error('boom') }), dir);
    const svg = exportSvg(broken).svg;
    expect(svg).toContain('The check could not run on fixture (adapter-failed)');
    expect(wellFormed(svg)).toBe(true);
    expect(exportFileName(snapshot, 'svg')).toBe('acme-shop-x-map.svg');
    expect(exportFileName(snapshot, 'svg', NESTED)).toBe('engine-map.svg');
    expect(exportFileName(snapshot, 'mermaid', NESTED)).toBe('acme-shop-x-buckets.mmd');
  });
});

describe('bucket graph as Mermaid', () => {
  it('nests projects and buckets as subgraphs and draws every contract with its symbol count', () => {
    const graph = exportMermaid(snapshot);
    const lines = graph.text.split('\n');
    expect(lines[0]).toBe('flowchart TB');
    expect(graph.text).toContain('subgraph P0["@acme/shop #quot;x#quot; (repo)"]');
    expect(graph.text).toContain(`subgraph P1["engine (${NESTED})"]`);
    // The nested project sits inside the subgraph of the bucket that holds it.
    const log = lines.findIndex((l) => /^\s*subgraph P0_B\d+\["log\/"\]$/.test(l));
    const nested = lines.findIndex((l) => l.includes('subgraph P1['));
    expect(log).toBeGreaterThan(0);
    expect(nested).toBeGreaterThan(log);
    expect(graph.edges.map((e) => `${e.kind} ${e.file ?? ''} ${e.label}`)).toEqual(
      expect.arrayContaining([
        'down root/billing/dmz/.parent/invoices.ts 1 symbol',
        'contract root/dmz/log/billing.ts 1 symbol',
        'publish root/dmz/core/.external.ts 1 symbol',
        'link root/web/_/links/engine link engine',
        'cycle  cycle',
      ]),
    );
    expect(graph.text).toContain('-.->|"link engine"|');
    expect(graph.text).toContain('==>|"cycle"|');
    expect(graph.text).toContain('classDef violation fill:#1a0402,stroke:#ff6e61,color:#ffd3cd');
    expect(graph.text).toMatch(/linkStyle [\d,]+ stroke:#ffc04d/);
  });

  it('keeps to a conservative flowchart syntax', () => {
    const lines = exportText(snapshot, 'mermaid').trimEnd().split('\n');
    const ids = new Set<string>();
    let depth = 0;
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (t.startsWith('%%')) continue;
      let m: RegExpExecArray | null;
      if ((m = /^subgraph (\w+)\["[^"\n]*"\]$/.exec(t))) {
        depth++;
        ids.add(m[1]!);
      } else if (t === 'end') depth--;
      else if ((m = /^(\w+)(\["[^"\n]*"\]|\{\{"[^"\n]*"\}\}|\(\["[^"\n]*"\]\)|\[\/"[^"\n]*"\/\])$/.exec(t))) ids.add(m[1]!);
      else if ((m = /^(\w+) (-->|-\.->|==>)\|"[^"\n|]*"\| (\w+)$/.exec(t))) {
        expect(ids.has(m[1]!), line).toBe(true);
        expect(ids.has(m[3]!), line).toBe(true);
      } else if (!/^(classDef \w+ [\w#:,.-]+(?: [\w#:,.-]+)*|class [\w,]+ \w+|style \w+ [\w#:,.-]+|linkStyle [\d,]+ [\w#:,.-]+)$/.test(t)) {
        throw new Error(`unexpected line: ${line}`);
      }
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('matches the snapshot of the fixture', () => {
    expect(exportMermaid(snapshot).text).toMatchSnapshot();
  });

  it('escapes what would end a label', () => {
    expect(mermaidLabel('a "b" <c> #d\ne')).toBe('a #quot;b#quot; #lt;c#gt; #35;d e');
  });
});

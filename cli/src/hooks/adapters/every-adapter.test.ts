// Every adapter with hooks, install and uninstall: the hook commands of a local install, and an uninstall that leaves
// the project as it was before install.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, makeProject } from '../../testing/fixture.js';
import { ADAPTERS } from '../registry.js';

afterEach(cleanupProjects);

const LOCAL = 'node ./node_modules/slopbuckets/dist/index.js';
const PLUGINS = ['opencode', 'pi', 'amp'];
/** The harnesses that set a project folder variable and run hooks in a POSIX shell, so the command names the copy by it. */
const ANCHORED: Record<string, string> = { claude: 'CLAUDE_PROJECT_DIR', crush: 'CRUSH_PROJECT_DIR', devin: 'DEVIN_PROJECT_DIR', factory: 'FACTORY_PROJECT_DIR' };
/** A Kiro CLI 2.x agent config of the user, which install adds a hook to. */
const USER_FILES: Record<string, Record<string, string>> = { kiro: { '.kiro/agents/dev.json': '{ "name": "dev" }\n' } };
/** What uninstall keeps on purpose: Gemini's context.fileName setting. */
const KEPT: Record<string, string[]> = { gemini: ['.gemini/settings.json'] };

function files(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    return entry.isDirectory() ? files(dir, child) : [child];
  });
}

const text = (dir: string): string => files(dir).map((file) => readFileSync(path.join(dir, file), 'utf8')).join('\n');

describe.each(ADAPTERS.filter((adapter) => adapter.events.length > 0).map((adapter) => [adapter.name, adapter] as const))('%s', (name, adapter) => {
  it('writes every hook command with the command of a local install', () => {
    const dir = makeProject(USER_FILES[name] ?? {}, false);
    const steps = adapter.install(dir, { skill: 'the skill\n', command: LOCAL });
    expect(steps.filter((step) => step.status === 'failed')).toEqual([]);
    const written = text(dir);
    if (PLUGINS.includes(name)) {
      expect(written).toContain(`const COMMAND = ${JSON.stringify(LOCAL)};`);
      return;
    }
    // `slopbuckets hooks` in a description is fine; a command `buckets hook` is not.
    expect(written).not.toMatch(/(?<![\w/])buckets hook/);
    const events = name === 'kiro' ? ['pre-tool-use', 'stop'] : adapter.events;
    const variable = ANCHORED[name];
    // In a JSON file the quotes around the anchored script are escaped.
    const cli = variable === undefined ? LOCAL : JSON.stringify(`node "$${variable}/node_modules/slopbuckets/dist/index.js"`).slice(1, -1);
    for (const event of events) expect(written).toContain(name === 'claude' ? `${cli} hook ${event}` : `${cli} hook --agent ${name} ${event}`);
  });

  it.skipIf(PLUGINS.includes(name))('lists every file that holds a hook command in hookFiles, which buckets doctor reads', () => {
    const dir = makeProject(USER_FILES[name] ?? {}, false);
    adapter.install(dir, { skill: 'the skill\n', command: LOCAL });
    const holders = files(dir).filter((file) => /index\.js\\?"? hook /.test(readFileSync(path.join(dir, file), 'utf8')));
    expect(holders.length).toBeGreaterThan(0);
    const listed = (file: string) => adapter.hookFiles.some((h) => (h.endsWith('/') ? file.startsWith(h) && !file.slice(h.length).includes('/') : file === h));
    expect(holders.filter((file) => !listed(file))).toEqual([]);
  });

  it('uninstall removes what install wrote, after either command', () => {
    for (const command of [undefined, LOCAL]) {
      const dir = makeProject(USER_FILES[name] ?? {}, false);
      const before = text(dir);
      adapter.install(dir, { skill: 'the skill\n', ...(command === undefined ? {} : { command }) });
      const steps = adapter.uninstall(dir);
      expect(steps.filter((step) => step.status === 'failed')).toEqual([]);
      expect(steps.length).toBeGreaterThan(0);
      expect(files(dir).filter((file) => !(KEPT[name] ?? []).includes(file))).toEqual(Object.keys(USER_FILES[name] ?? {}));
      if (KEPT[name] === undefined) expect(text(dir).replace(/\s/g, '')).toBe(before.replace(/\s/g, ''));
      expect(adapter.uninstall(dir)).toEqual([]);
    }
  });
});

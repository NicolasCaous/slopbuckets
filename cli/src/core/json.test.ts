import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, LOGGER_PROJECT, makeProject, readFile, writeFile } from '../testing/fixture.js';
import { approve, checkProject } from '../testing/harness.js';
import { loadConfig } from './config.js';
import { parseJson, stripBom } from './json.js';
import { readLock } from './lock.js';

afterEach(cleanupProjects);

const BOM = '﻿';

describe('UTF-8 byte order mark', () => {
  it('strips one leading BOM and nothing else', () => {
    expect(stripBom(`${BOM}{}`)).toBe('{}');
    expect(stripBom('{}')).toBe('{}');
    expect(stripBom(` ${BOM}`)).toBe(` ${BOM}`);
    expect(parseJson(`${BOM}{"a": 1}`)).toEqual({ a: 1 });
  });

  it('reads buckets.config.json saved with a BOM', () => {
    const dir = makeProject({ 'buckets.config.json': `${BOM}{ "root": "src", "alias": "~" }\n` });
    const result = loadConfig(dir);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.config).toMatchObject({ root: 'src', alias: '~' });
  });

  it('reads a lock saved with a BOM and finds no difference', async () => {
    const dir = makeProject({ ...LOGGER_PROJECT, 'buckets.config.json': `${BOM}{ "root": "root" }\n` });
    await approve(dir);
    writeFile(dir, 'buckets.lock.json', `${BOM}${readFile(dir, 'buckets.lock.json')}`);
    expect(readLock(dir).kind).toBe('ok');
    const { report } = await checkProject(dir);
    expect(report).toEqual({ exitCode: 0, violations: [], lockChanges: [] });
  });

  it('reads a package.json saved with a BOM in the fake adapter, like the real one must', async () => {
    const dir = makeProject({
      ...LOGGER_PROJECT,
      'package.json': `${BOM}${JSON.stringify({ name: 'fixture', dependencies: { axios: '1.0.0' } })}`,
      'root/_/main.ts': "import axios from 'axios';\naxios();\n",
    });
    const { report } = await checkProject(dir);
    expect(report.violations).toEqual([]);
  });
});

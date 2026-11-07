// An adapter that speaks another protocol version is an environment error, not a crash or a wrong result.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { createEngine } from './engine.js';

vi.mock('@slopbuckets/adapter-ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('@slopbuckets/adapter-ts')>();
  return { ...m, info: () => ({ ...m.info(), abi: 3 }) };
});

afterEach(cleanupProjects);

it('fails with adapter-failed when the adapter speaks another protocol', async () => {
  const dir = makeProject({
    'buckets.config.json': JSON.stringify({ version: '2.0', buckets: { app: { purpose: 'Runs', files: ['src/**'], public: null, dependsOn: {}, packages: {} } } }),
    'tsconfig.json': '{}',
    'src/main.ts': 'export {};\n',
  });
  const result = await createEngine({ cliVersion: 'test' }).checkAll(dir);
  expect(result).toMatchObject({ exitCode: 3, environment: [{ code: 'adapter-failed', message: expect.stringContaining('speaks protocol 3, and this CLI speaks protocol 2') }] });
});

import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { cleanupProjects, makeProject, readFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';
import { formatConfig } from './fmt.js';

afterEach(cleanupProjects);

async function run(dir: string, args: string[]) {
  const io = fakeIo({ cwd: dir });
  const code = await main(testContext(), io, args);
  return { code, out: io.out, err: io.err };
}

const MESSY = JSON.stringify({
  buckets: {
    payments: { packages: { zod: 'Validates payloads', 'node:fs': 'Writes files' }, files: ['src/payments/**'], purpose: 'Talks to the gateway', public: 'src/payments/index.ts', dependsOn: {} },
    app: { dependsOn: { payments: 'Mounts the webhook', billing: 'Mounts the invoices' }, purpose: 'Starts the server', files: ['src/app/**', '!src/app/gen/**'], public: null, packages: {} },
  },
  version: '2.0',
  $schema: 'https://nicolascaous.github.io/slopbuckets/schema/v2.json',
  ignore: ['scripts/**'],
});

const CANONICAL = `{
  "$schema": "https://nicolascaous.github.io/slopbuckets/schema/v2.json",
  "version": "2.0",
  "ignore": ["scripts/**"],
  "buckets": {
    "app": {
      "purpose": "Starts the server",
      "files": [
        "src/app/**",
        "!src/app/gen/**"
      ],
      "public": null,
      "dependsOn": {
        "billing": "Mounts the invoices",
        "payments": "Mounts the webhook"
      },
      "packages": {}
    },
    "payments": {
      "purpose": "Talks to the gateway",
      "files": ["src/payments/**"],
      "public": "src/payments/index.ts",
      "dependsOn": {},
      "packages": {
        "node:fs": "Writes files",
        "zod": "Validates payloads"
      }
    }
  }
}
`;

describe('buckets fmt', () => {
  it('writes the canonical form: key order, sorted buckets and maps, one item per line from two items', () => {
    expect(formatConfig(JSON.parse(MESSY))).toBe(CANONICAL);
    expect(formatConfig(JSON.parse(CANONICAL))).toBe(CANONICAL);
  });

  it('--check exits with 1 on an unformatted config and changes nothing; fmt then rewrites it and the nested configs', async () => {
    const dir = makeProject({ 'buckets.config.json': JSON.stringify({ ...JSON.parse(MESSY), projects: ['sdk'] }), 'sdk/buckets.config.json': '{"version":"2.0","buckets":{}}' }, false);
    const check = await run(dir, ['fmt', '--check']);
    expect(check).toEqual({ code: 1, out: 'buckets.config.json is not formatted. Run buckets fmt.\nsdk/buckets.config.json is not formatted. Run buckets fmt.\n', err: '' });
    expect(readFile(dir, 'sdk/buckets.config.json')).toBe('{"version":"2.0","buckets":{}}');
    expect((await run(dir, ['fmt'])).out).toBe('Formatted buckets.config.json\nFormatted sdk/buckets.config.json\n');
    expect(readFile(dir, 'sdk/buckets.config.json')).toBe('{\n  "version": "2.0",\n  "buckets": {}\n}\n');
    expect(await run(dir, ['fmt', '--check'])).toEqual({ code: 0, out: '', err: '' });
  });

  it('leaves a config that is not JSON as it is, and exits with 64 on an unknown option', async () => {
    const dir = makeProject({ 'buckets.config.json': '{ "buckets": ' }, false);
    const result = await run(dir, ['fmt']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('buckets.config.json is not valid JSON');
    expect(readFile(dir, 'buckets.config.json')).toBe('{ "buckets": ');
    const bad = await run(dir, ['fmt', '--chek']);
    expect(bad.code).toBe(64);
    expect(bad.err).toContain('Usage: buckets fmt [--check]');
  });
});

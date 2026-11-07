import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { renderFull } from '../contract/messages.js';
import type { Violation } from '../contract/violation.js';
import { createFakeEngine } from '../testing/fake-engine.js';
import { cleanupProjects, makeProject } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';

afterEach(cleanupProjects);

const CONFIG = JSON.stringify({
  version: '2.0',
  projects: ['sdk'],
  buckets: {
    app: { purpose: 'Starts the server', files: ['src/app/**'], public: null, dependsOn: { billing: 'Mounts the invoice routes' }, packages: { express: 'Serves the HTTP routes' } },
    billing: { purpose: 'Issues invoices', files: ['src/billing/**'], public: ['src/billing/index.ts', 'src/billing/server.ts'], dependsOn: { log: 'Logs every charge' }, packages: {}, external: 'Entry of the npm package' },
    jobs: { purpose: 'Runs nightly jobs', files: ['src/jobs/**'], public: null, dependsOn: { billing: 'Sends the overdue reminders' }, packages: {} },
    log: { purpose: 'Writes the logs', files: ['src/log/**'], public: 'src/log/index.ts', dependsOn: {}, packages: {} },
  },
});
const SDK = JSON.stringify({ version: '2.0', buckets: { client: { purpose: 'Calls the API', files: ['src/**'], public: 'src/index.ts', dependsOn: {}, packages: {} } } });

const unused: Violation = { rule: 'dependency-unused', project: '.', from: 'billing', to: 'log', reason: 'Logs every charge' };
const other: Violation = { rule: 'dependency-unused', project: '.', from: 'app', to: 'jobs', reason: 'x' };

async function run(args: string[]) {
  const dir = makeProject({ 'buckets.config.json': CONFIG, 'sdk/buckets.config.json': SDK }, false);
  const engine = createFakeEngine({ violations: [unused, other] });
  const io = fakeIo({ cwd: dir });
  const code = await main({ ...testContext(), engine }, io, args);
  return { code, out: io.out, err: io.err, engine };
}

describe('buckets show', () => {
  it('prints the bucket, its dependents with their reasons and its violations in full', async () => {
    const { code, out } = await run(['show', 'billing']);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        'billing',
        '  purpose: Issues invoices',
        '  files:',
        '    src/billing/**',
        '  public:',
        '    src/billing/index.ts',
        '    src/billing/server.ts',
        '  dependsOn:',
        '    log: Logs every charge',
        '  packages:',
        '    none',
        '  external: Entry of the npm package',
        '  dependents:',
        '    app: Mounts the invoice routes',
        '    jobs: Sends the overdue reminders',
        '  violations: 1',
        '',
        renderFull(unused),
        '',
      ].join('\n'),
    );
  });

  it('prints JSON, and reads a bucket of a nested project as <project>:<bucket>', async () => {
    const app = JSON.parse((await run(['show', 'app', '--json'])).out);
    expect(app).toMatchObject({ project: '.', bucket: 'app', public: null, packages: { express: 'Serves the HTTP routes' }, dependents: [], violations: [other], environment: [] });
    const nested = await run(['show', 'sdk:client']);
    expect(nested.out.split('\n')[0]).toBe('sdk:client');
    expect(nested.engine.calls[0]).toMatchObject({ method: 'checkAll', recursive: false });
  });

  it('exits with 64 for an unknown bucket or bad arguments', async () => {
    const unknown = await run(['show', 'nope']);
    expect(unknown.code).toBe(64);
    expect(unknown.err).toContain('has no bucket "nope". Buckets: app, billing, jobs, log.');
    expect((await run(['show'])).code).toBe(64);
    expect((await run(['show', 'app', '--jsn'])).code).toBe(64);
  });
});

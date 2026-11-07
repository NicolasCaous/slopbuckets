import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { renderCheck, renderCheckSummary, renderSummary } from '../contract/messages.js';
import { createFakeEngine } from '../testing/fake-engine.js';
import { cleanupProjects, makeProject, writeFile } from '../testing/fixture.js';
import { fakeIo, testContext, TEST_CLI_VERSION } from '../testing/harness.js';
import { ADVICE_SAMPLES, SAMPLES } from '../testing/samples.js';
import { architectureDiff } from './check.js';

afterEach(cleanupProjects);

const nested = { ...SAMPLES['import-private'], project: 'packages/sdk' };
const violations = [SAMPLES['import-private'], SAMPLES['file-unowned'], nested];
const environment = [{ code: 'no-tsconfig' as const, project: 'apps/web', message: 'Create a tsconfig.json in apps/web.' }];
const advice = [ADVICE_SAMPLES['reason-generic']];
const context = (script: Parameters<typeof createFakeEngine>[0] = { violations, advice }) => ({ ...testContext(), engine: createFakeEngine(script) });

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
}

describe('buckets check output formats', () => {
  it('passes the advice to renderCheck, and --summary prints renderCheckSummary', async () => {
    const dir = makeProject({});
    const result = await context().engine.checkAll(dir);
    const text = fakeIo({ cwd: dir });
    expect(await main(context(), text, ['check'])).toBe(1);
    expect(text.out).toBe(`${renderCheck(result.violations, [], advice)}\n`);
    expect(text.out).not.toBe(`${renderCheck(result.violations, [])}\n`);
    const summary = fakeIo({ cwd: dir });
    expect(await main(context(), summary, ['check', '--summary'])).toBe(1);
    expect(summary.out).toBe(`${renderCheckSummary(result.violations, result.environment, result.advice)}\n`);
    expect(summary.out).toContain('By rule:');
  });

  it('prints ::error annotations on stderr with --format github or GITHUB_ACTIONS=true, with paths from GITHUB_WORKSPACE', async () => {
    const dir = makeProject({});
    const io = fakeIo({ cwd: dir, env: { GITHUB_WORKSPACE: path.dirname(dir) } });
    expect(await main(context({ violations, environment }), io, ['check', '--format', 'github'])).toBe(3);
    const name = path.basename(dir);
    const lines = io.err.trimEnd().split('\n');
    expect(lines).toContain(`::error file=${name}/src/billing/invoice.ts,line=3,title=slopbuckets import-private::${renderSummary(SAMPLES['import-private'])}`);
    expect(lines).toContain(`::error file=${name}/packages/sdk/src/billing/invoice.ts,line=3,title=slopbuckets import-private::${renderSummary(nested)}`);
    expect(lines).toContain(`::error file=${name}/src/utils/date.ts,title=slopbuckets file-unowned::${renderSummary(SAMPLES['file-unowned'])}`);
    expect(lines).toContain('::error title=slopbuckets::apps/web: cannot check (no-tsconfig): Create a tsconfig.json in apps/web.');
    expect(io.out).toBe(`${renderCheck((await context({ violations }).engine.checkAll(dir)).violations, environment)}\n`);

    const json = fakeIo({ cwd: dir, env: { GITHUB_ACTIONS: 'true' } });
    await main(context(), json, ['check', '--json']);
    expect(JSON.parse(json.out).violations).toHaveLength(3);
    expect(json.err).toContain('::error file=src/billing/invoice.ts,line=3,');

    const plain = fakeIo({ cwd: dir });
    await main(context(), plain, ['check']);
    expect(plain.err).toBe('');
  });

  it('escapes the data and the properties of an annotation', async () => {
    const dir = makeProject({});
    const odd = { ...SAMPLES['file-unowned'], file: 'src/a,b:c.ts' };
    const io = fakeIo({ cwd: dir });
    await main(context({ violations: [odd] }), io, ['check', '--format', 'github']);
    expect(io.err).toContain('::error file=src/a%2Cb%3Ac.ts,title=slopbuckets file-unowned::');
  });

  it('prints a SARIF 2.1.0 log with --format sarif', async () => {
    const dir = makeProject({});
    const io = fakeIo({ cwd: dir, env: { GITHUB_ACTIONS: 'true' } });
    expect(await main(context({ violations, environment }), io, ['check', '--format', 'sarif'])).toBe(3);
    const log = JSON.parse(io.out);
    expect(log.version).toBe('2.1.0');
    const run = log.runs[0];
    expect(run.tool.driver).toMatchObject({ name: 'slopbuckets', version: TEST_CLI_VERSION });
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id).sort()).toEqual(['file-unowned', 'import-private']);
    expect(run.results).toHaveLength(3);
    expect(run.results).toContainEqual(
      expect.objectContaining({ ruleId: 'import-private', level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: 'packages/sdk/src/billing/invoice.ts' }, region: { startLine: 3 } } }] }),
    );
    expect(run.results.find((r: { ruleId: string }) => r.ruleId === 'file-unowned').locations[0].physicalLocation.region).toBeUndefined();
    expect(run.invocations[0]).toMatchObject({ executionSuccessful: false, toolExecutionNotifications: [{ level: 'error' }] });
    expect(io.err).toBe('');
  });

  it('prints one notice on stderr when a skill copy is not the one of this CLI', async () => {
    const stamp = (version: string) => `---\nname: slopbuckets\nmetadata:\n  slopbuckets-version: "${version}"\n---\n# skill\n`;
    const dir = makeProject({ '.claude/skills/slopbuckets/SKILL.md': stamp('0.9.0'), '.agents/skills/slopbuckets/SKILL.md': '# skill\n' });
    const io = fakeIo({ cwd: dir });
    await main(context({}), io, ['check']);
    expect(io.err).toBe(
      'slopbuckets: the skill in .claude/skills/slopbuckets/SKILL.md (0.9.0) and .agents/skills/slopbuckets/SKILL.md (no version) is not the one of slopbuckets 1.0.0. Run `buckets init` to copy the current skill.\n',
    );
    writeFile(dir, '.claude/skills/slopbuckets/SKILL.md', stamp(TEST_CLI_VERSION));
    writeFile(dir, '.agents/skills/slopbuckets/SKILL.md', stamp(TEST_CLI_VERSION));
    const fresh = fakeIo({ cwd: dir });
    await main(context({}), fresh, ['check']);
    expect(fresh.err).toBe('');
  });
});

describe('buckets check --base', () => {
  const bucket = (purpose: string, extra: Record<string, unknown> = {}) => ({ purpose, files: [`src/${purpose.split(' ')[0]!.toLowerCase()}/**`], public: null, dependsOn: {}, packages: {}, ...extra });
  const before = {
    version: '2.0',
    projects: ['packages/sdk'],
    buckets: {
      billing: bucket('Billing issues invoices', { public: 'src/billing/index.ts', dependsOn: { payments: 'Charges each invoice' }, packages: { zod: 'Validates payloads' } }),
      payments: bucket('Payments talks to the gateway', { public: 'src/payments/index.ts' }),
      legacy: bucket('Legacy code from 1.x'),
    },
  };
  const after = {
    version: '2.0',
    projects: ['packages/sdk'],
    buckets: {
      billing: bucket('Billing issues and charges invoices', {
        public: ['src/billing/index.ts', 'src/billing/server.ts'],
        dependsOn: { payments: 'Charges each invoice through the gateway', mail: 'Sends each invoice' },
        packages: { 'node:fs': 'Writes invoice PDFs' },
      }),
      payments: bucket('Payments talks to the gateway', { public: 'src/payments/index.ts' }),
      mail: bucket('Mail sends email', { public: 'src/mail/index.ts' }),
    },
  };
  const sdk = (purpose: string) => JSON.stringify({ version: '2.0', buckets: { sdk: bucket(purpose) } });

  function setup() {
    const dir = makeProject(
      {
        'buckets.config.json': JSON.stringify(before),
        'tsconfig.json': '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler" } }',
        'src/billing/index.ts': "export { issue } from './issue';\n",
        'src/billing/issue.ts': 'export const issue = 1;\nexport const draft = 2;\n',
        'src/payments/index.ts': "export { charge, refund } from './charge';\n",
        'src/payments/charge.ts': 'export const charge = 1;\nexport const refund = 2;\n',
        'packages/sdk/buckets.config.json': sdk('Sdk is the client'),
        'packages/sdk/tsconfig.json': '{}',
      },
      false,
    );
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    writeFile(dir, 'buckets.config.json', JSON.stringify(after));
    writeFile(dir, 'src/billing/index.ts', "export { issue, draft } from './issue';\n");
    writeFile(dir, 'src/billing/server.ts', "export { issue as serve } from './issue';\n");
    writeFile(dir, 'src/payments/index.ts', "export { charge } from './charge';\n");
    writeFile(dir, 'src/mail/index.ts', "export { send } from './send';\n");
    writeFile(dir, 'src/mail/send.ts', 'export const send = 1;\n');
    writeFile(dir, 'packages/sdk/buckets.config.json', sdk('Sdk is the public client'));
    return dir;
  }

  it('lists the buckets, dependencies, packages, purposes, public files and exports that changed, project by project', () => {
    const dir = setup();
    expect(architectureDiff(dir, 'HEAD', true)).toEqual({
      sections: [
        {
          title: 'Architecture changes since HEAD:',
          lines: [
            'Changed the purpose of `billing` from "Billing issues invoices" to "Billing issues and charges invoices"',
            'Changed the reason of the dependency of `billing` on `payments` from "Charges each invoice" to "Charges each invoice through the gateway"',
            'Added the dependency of `billing` on `mail`: Sends each invoice',
            'Added the package `node:fs` to `billing`: Writes invoice PDFs',
            'Removed the package `zod` from `billing`: Validates payloads',
            'Changed the public files of `billing` from src/billing/index.ts to src/billing/index.ts, src/billing/server.ts',
            'Removed bucket `legacy`: Legacy code from 1.x',
            'Added bucket `mail`: Mail sends email',
            'Added the export `draft` to src/billing/index.ts, a public file of `billing`',
            'Added the export `serve` to src/billing/server.ts, a public file of `billing`',
            'Added the export `send` to src/mail/index.ts, a public file of `mail`',
            'Removed the export `refund` from src/payments/index.ts, a public file of `payments`',
          ],
        },
        { title: 'Architecture changes in packages/sdk since HEAD:', lines: ['Changed the purpose of `sdk` from "Sdk is the client" to "Sdk is the public client"'] },
      ],
    });
    expect(architectureDiff(dir, 'HEAD', false).sections).toHaveLength(1);
  });

  it('prints the diff after the check, appends it to GITHUB_STEP_SUMMARY as Markdown, and keeps the exit code', async () => {
    const dir = setup();
    const summary = path.join(dir, 'summary.md');
    writeFile(dir, 'summary.md', '# earlier step\n');
    const io = fakeIo({ cwd: dir, env: { GITHUB_STEP_SUMMARY: summary } });
    expect(await main(context({}), io, ['check', '--base', 'HEAD', '--no-recursive'])).toBe(0);
    expect(io.out).toContain('buckets check: no structure violations.\n\nArchitecture changes since HEAD:\n  Changed the purpose of `billing`');
    const markdown = readFileSync(summary, 'utf8');
    expect(markdown).toMatch(/^# earlier step\n### Architecture changes since HEAD\n\n- Changed the purpose of `billing`/);
    expect(markdown).not.toContain('packages/sdk');

    const json = fakeIo({ cwd: dir });
    expect(await main(context({ violations: [SAMPLES['file-unowned']] }), json, ['check', '--json', '--base', 'HEAD'])).toBe(1);
    expect(JSON.parse(json.out).exitCode).toBe(1);
    expect(json.err).toContain('Architecture changes in packages/sdk since HEAD:');
  });

  it('says so when nothing changed, and when the ref is not a commit', async () => {
    const dir = setup();
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'after');
    const same = fakeIo({ cwd: dir });
    expect(await main(context({}), same, ['check', '--base', 'HEAD'])).toBe(0);
    expect(same.out).toContain('\nNo architecture changes since HEAD.\n');
    const bad = fakeIo({ cwd: dir });
    expect(await main(context({}), bad, ['check', '--base', 'nope'])).toBe(0);
    expect(bad.out).toContain('buckets check --base: nope is not a commit in the git repository of');
  });
});

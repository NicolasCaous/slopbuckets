import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.js';
import { renameDefault } from './fix.js';
import { createEngine } from '../engine/engine.js';
import { createFakeEngine } from '../testing/fake-engine.js';
import { cleanupProjects, makeProject, readFile } from '../testing/fixture.js';
import { fakeIo, testContext } from '../testing/harness.js';

afterEach(cleanupProjects);

const realContext = () => ({ ...testContext(), engine: createEngine({ cliVersion: 'test' }) });

function tsconfig(paths: Record<string, string[]> = {}): string {
  return JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, paths } });
}

function config(buckets: Record<string, { files: string[]; public: string | string[] | null; dependsOn?: Record<string, string> }>): string {
  const full = Object.fromEntries(Object.entries(buckets).map(([name, b]) => [name, { purpose: `Keeps the ${name} rules and records`, dependsOn: {}, packages: {}, ...b }]));
  return JSON.stringify({ version: '2.0', buckets: full }, null, 2);
}

function repo(files: Record<string, string>): string {
  const dir = makeProject(files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function run(dir: string, args: string[], ctx = realContext()) {
  const io = fakeIo({ cwd: dir });
  const code = await main(ctx, io, args);
  return { code, out: io.out, err: io.err };
}

const CHARGE = 'export function charge(): number {\n  return 1;\n}\nexport const rate = 2;\nexport interface Invoice {\n  id: string;\n}\nexport default function start(): void {}\n';

describe('buckets fix import-private', () => {
  it('re-exports every name and points each statement at the public file, keeping the @/ alias', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig({ '@/*': ['./src/*'] }),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/start.ts': CHARGE,
      'src/billing/money.ts': 'export type Money = number;\n',
      'src/billing/index.ts': "export { charge } from './charge';\n",
      'src/app/main.ts': [
        "import begin, { rate as r, type Invoice } from '@/billing/start';",
        "import type { Money } from '@/billing/money';",
        "import { charge } from '@/billing';",
        "import { rate } from '@/billing/start';",
        '',
        'export const invoice: Invoice = { id: String(r + rate + charge()) };',
        'export const money: Money = 1;',
        'begin();',
        '',
      ].join('\n'),
    });
    // The engine of R2 reports these, typeOnly included. The engine before R2 marks every name as a value.
    const imp = (line: number, target: string, names: [string, boolean][]) => ({ file: 'src/app/main.ts', line, target, names: names.map(([name, typeOnly]) => ({ name, typeOnly })) });
    const engine = createFakeEngine({
      violations: [
        {
          rule: 'import-private',
          project: '.',
          from: 'app',
          to: 'billing',
          imports: [
            imp(1, 'src/billing/start.ts', [['default', false], ['rate', false], ['Invoice', true]]),
            imp(2, 'src/billing/money.ts', [['Money', true]]),
            imp(4, 'src/billing/start.ts', [['rate', false]]),
          ],
          public: ['src/billing/index.ts'],
        },
      ],
    });
    const ctx = { ...testContext(), engine };
    const dry = await run(dir, ['fix', 'import-private', '--dry-run'], ctx);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Dry run, nothing was written.');
    expect(readFile(dir, 'src/billing/index.ts')).toBe("export { charge } from './charge';\n");

    const fixed = await run(dir, ['fix', 'import-private'], ctx);
    expect(fixed.code).toBe(0);
    expect(readFile(dir, 'src/billing/index.ts')).toBe(
      "export { charge } from './charge';\nexport type { Money } from './money';\nexport { default as start, rate } from './start';\nexport type { Invoice } from './start';\n",
    );
    expect(readFile(dir, 'src/app/main.ts').split('\n').slice(0, 4)).toEqual([
      "import { start as begin, rate as r, type Invoice } from '@/billing';",
      "import type { Money } from '@/billing';",
      "import { charge } from '@/billing';",
      "import { rate } from '@/billing';",
    ]);
    expect(fixed.out).toContain("src/app/main.ts:1: '@/billing/start' -> '@/billing', with { start } in place of the default import");
    expect((await run(dir, ['check'])).code).toBe(0);

    const again = await run(dir, ['fix', 'import-private']);
    expect(again).toEqual({ code: 0, out: 'No private imports to fix.\n', err: '' });
  });

  it('keeps an exact alias of the public file with the real engine, and is idempotent', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig({ '@billing': ['./src/billing/index.ts'], '@billing/*': ['./src/billing/*'] }),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/index.ts': "export { charge } from './charge';\n",
      'src/app/main.ts': "import { charge } from '@billing';\nimport { rate as r } from '@billing/charge';\n\nconsole.log(charge(), r);\n",
    });
    const fixed = await run(dir, ['fix', 'import-private']);
    expect(fixed).toEqual({
      code: 0,
      out: "src/billing/index.ts:\n  + export { rate } from './charge';\nsrc/app/main.ts:2: '@billing/charge' -> '@billing'\n",
      err: '',
    });
    expect(readFile(dir, 'src/app/main.ts')).toBe("import { charge } from '@billing';\nimport { rate as r } from '@billing';\n\nconsole.log(charge(), r);\n");
    expect((await run(dir, ['check'])).code).toBe(0);
    expect((await run(dir, ['fix', 'import-private'])).out).toBe('No private imports to fix.\n');
  });

  it('re-exports an interface or type alias imported without `type` as export type, as the check message says', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/period.ts': "export type Period = 'day' | 'week';\n",
      'src/billing/index.ts': '',
      'src/app/main.ts': "import { charge, Invoice } from '../billing/charge';\nimport { Period } from '../billing/period';\n\nexport const bill: Invoice = { id: String(charge()) };\nexport const period: Period = 'day';\n",
    });
    const check = await run(dir, ['check']);
    expect(check.out).toContain("add the re-exports it lacks: export { charge } from './charge', export type { Invoice } from './charge', export type { Period } from './period'");
    expect((await run(dir, ['fix', 'import-private'])).code).toBe(0);
    expect(readFile(dir, 'src/billing/index.ts')).toBe("export { charge } from './charge';\nexport type { Invoice } from './charge';\nexport type { Period } from './period';\n");
    expect((await run(dir, ['check'])).code).toBe(0);
  });

  it('re-exports a private default under the file name when the public file already has a default, as the check message says', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { icons: 'Draws the logo in the sidebar' } },
        icons: { files: ['src/icons/**'], public: 'src/icons/index.ts' },
      }),
      'src/icons/HandyTextLogo.ts': 'export default function HandyTextLogo(): string {\n  return "logo";\n}\n',
      'src/icons/HandyHand.ts': 'export default function HandyHand(): string {\n  return "hand";\n}\n',
      'src/icons/index.ts': "export { default } from './HandyTextLogo';\n",
      'src/app/Sidebar.ts': "import Logo from '../icons';\nimport Hand from '../icons/HandyHand';\nexport { default as Mark } from '../icons/HandyHand';\n\nconsole.log(Logo(), Hand());\n",
    });
    const check = await run(dir, ['check']);
    expect(check.out).toContain("import from src/icons/index.ts instead, with { HandyHand } in place of the default import, and add the re-exports it lacks: export { default as HandyHand } from './HandyHand'");
    const fixed = await run(dir, ['fix', 'import-private']);
    expect(fixed.code).toBe(0);
    expect(readFile(dir, 'src/icons/index.ts')).toBe("export { default } from './HandyTextLogo';\nexport { default as HandyHand } from './HandyHand';\n");
    expect(readFile(dir, 'src/app/Sidebar.ts')).toBe("import Logo from '../icons';\nimport { HandyHand as Hand } from '../icons';\nexport { HandyHand as Mark } from '../icons';\n\nconsole.log(Logo(), Hand());\n");
    expect((await run(dir, ['check'])).code).toBe(0);
  });

  it('prints one skip line per reason with a count, and keeps the CRLF line endings of the public file', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order', cli: 'Reuses the command parser' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
        cli: { files: ['src/cli/**'], public: null },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/index.ts': "export { rate } from './charge';\r\n",
      'src/cli/parse.ts': 'export const parse = 1;\nexport const flag = 2;\nexport const help = 3;\n',
      'src/app/main.ts': "import { charge } from '../billing/charge';\r\nimport { parse } from '../cli/parse';\r\nimport { flag } from '../cli/parse';\r\nimport { help } from '../cli/parse';\r\n\r\nconsole.log(charge(), parse, flag, help);\r\n",
    });
    const result = await run(dir, ['fix', 'import-private']);
    expect(result.code).toBe(1);
    expect(result.out.split('\n').filter((l) => l.startsWith('skipped'))).toEqual([
      `skipped 3 imports, the first at src/app/main.ts:2: cli is closed ("public": null), so nothing of it may be imported. Give cli a public file in buckets.config.json and run this again, or move the code.`,
    ]);
    expect(readFile(dir, 'src/billing/index.ts')).toBe("export { rate } from './charge';\r\nexport { charge } from './charge';\r\n");
    expect(readFile(dir, 'src/app/main.ts').split('\r\n')[0]).toBe("import { charge } from '../billing';");
  });

  it('renames the default export in each statement form it knows', () => {
    expect(renameDefault('import', ' Hand ', 'HandyHand')).toBe(' { HandyHand as Hand } ');
    expect(renameDefault('import', ' HandyHand, { size } ', 'HandyHand')).toBe(' { HandyHand, size } ');
    expect(renameDefault('import', ' type Hand ', 'HandyHand')).toBe(' type { HandyHand as Hand } ');
    expect(renameDefault('import', ' { default as Hand, size } ', 'HandyHand')).toBe(' { HandyHand as Hand, size } ');
    expect(renameDefault('export', ' { default } ', 'HandyHand')).toBe(' { HandyHand as default } ');
    expect(renameDefault('export', ' { default as HandyHand, x as default } ', 'HandyHand')).toBe(' { HandyHand, x as default } ');
    expect(renameDefault('import', ' * as icons ', 'HandyHand')).toBeNull();
  });

  it('keeps relative specifiers with their .js extension and double quotes without semicolons', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
      }),
      'src/billing/sum.ts': 'export const total = 3\n',
      'src/billing/index.ts': '',
      'src/app/main.ts': 'import { total } from "../billing/sum.js"\n\nconsole.log(total)\n',
    });
    expect((await run(dir, ['fix', 'import-private'])).code).toBe(0);
    expect(readFile(dir, 'src/billing/index.ts')).toBe('export { total } from "./sum.js"\n');
    expect(readFile(dir, 'src/app/main.ts')).toBe('import { total } from "../billing/index.js"\n\nconsole.log(total)\n');
    expect((await run(dir, ['check'])).code).toBe(0);
  });

  it('fixes the private imports of an undeclared dependency and leaves dependsOn to the agent', async () => {
    const files = {
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null },
        billing: { files: ['src/billing/**'], public: ['src/billing/index.ts', 'src/billing/server.ts'] },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/index.ts': '',
      'src/billing/server.ts': '',
      'src/app/main.ts': "import { charge } from '../billing/charge';\n\ncharge();\n",
    };
    const dir = repo(files);
    // The R2 shape: no import-private for an undeclared pair, its private imports flagged inside dependency-undeclared.
    const engine = createFakeEngine({
      violations: [
        {
          rule: 'dependency-undeclared',
          project: '.',
          from: 'app',
          to: 'billing',
          fromPurpose: 'Keeps the app rules and records',
          toPurpose: 'Keeps the billing rules and records',
          imports: [{ file: 'src/app/main.ts', line: 1, target: 'src/billing/charge.ts', names: [{ name: 'charge', typeOnly: false }], private: true }],
          public: ['src/billing/index.ts', 'src/billing/server.ts'],
          dependents: [],
          reversePath: null,
        },
      ],
    });
    const result = await run(dir, ['fix', 'import-private', '--bucket', 'billing', '--public', 'src/billing/server.ts'], { ...testContext(), engine });
    expect(result.code).toBe(0);
    expect(result.out).toContain('note: app still imports billing without a dependsOn entry.');
    expect(readFile(dir, 'src/billing/server.ts')).toBe("export { charge } from './charge';\n");
    expect(readFile(dir, 'src/app/main.ts')).toBe("import { charge } from '../billing/server';\n\ncharge();\n");
    expect(readFile(dir, 'buckets.config.json')).toBe(files['buckets.config.json']);
    const check = JSON.parse((await run(dir, ['check', '--json'])).out);
    expect(check.violations.map((v: { rule: string }) => v.rule)).not.toContain('import-private');
  });

  it('creates a public file named with --public and adds it to the public files of the bucket', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/index.ts': "export { rate } from './charge';\n",
      'src/app/main.ts': "import { rate } from '../billing';\nimport { charge } from '../billing/charge';\n\ncharge();\nconsole.log(rate);\n",
    });
    expect((await run(dir, ['fix', 'import-private', '--bucket', 'billing', '--public', 'src/billing/api.ts'])).code).toBe(0);
    expect(readFile(dir, 'src/billing/api.ts')).toBe("export { charge } from './charge';\n");
    expect(JSON.parse(readFile(dir, 'buckets.config.json')).buckets.billing.public).toEqual(['src/billing/index.ts', 'src/billing/api.ts']);
  });

  it('refuses a closed bucket, and a name the public file exports from another file', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order', cli: 'Reuses the command parser' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
        cli: { files: ['src/cli/**'], public: null },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/other.ts': 'export const rate = 5;\n',
      'src/billing/index.ts': "export { rate } from './other';\n",
      'src/cli/parse.ts': 'export const parse = 1;\n',
      'src/app/main.ts': "import { rate } from '../billing/charge';\nimport { parse } from '../cli/parse';\n\nconsole.log(rate, parse);\n",
    });
    const before = readFile(dir, 'src/app/main.ts');
    const result = await run(dir, ['fix', 'import-private']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('skipped src/app/main.ts:1: src/billing/index.ts already exports rate from another file.');
    expect(result.out).toContain('skipped src/app/main.ts:2: cli is closed ("public": null)');
    expect(readFile(dir, 'src/app/main.ts')).toBe(before);
  });

  it('works from the contract fake engine, and exits with 64 on a bad argument', async () => {
    const dir = repo({
      'tsconfig.json': tsconfig(),
      'buckets.config.json': config({
        app: { files: ['src/app/**'], public: null, dependsOn: { billing: 'Charges each order' } },
        billing: { files: ['src/billing/**'], public: 'src/billing/index.ts' },
      }),
      'src/billing/charge.ts': CHARGE,
      'src/billing/index.ts': '',
      'src/app/main.ts': "import type { Invoice } from '../billing/charge';\n\nexport type Bill = Invoice;\n",
    });
    const engine = createFakeEngine({
      violations: [
        {
          rule: 'import-private',
          project: '.',
          from: 'app',
          to: 'billing',
          imports: [{ file: 'src/app/main.ts', line: 1, target: 'src/billing/charge.ts', names: [{ name: 'Invoice', typeOnly: true }] }],
          public: ['src/billing/index.ts'],
        },
      ],
    });
    expect((await run(dir, ['fix', 'import-private'], { ...testContext(), engine })).code).toBe(0);
    expect(readFile(dir, 'src/billing/index.ts')).toBe("export type { Invoice } from './charge';\n");
    expect(readFile(dir, 'src/app/main.ts')).toBe("import type { Invoice } from '../billing';\n\nexport type Bill = Invoice;\n");
    expect((await run(dir, ['fix', 'import-private', '--bogus'])).code).toBe(64);
    expect((await run(dir, ['fix'])).code).toBe(64);
  });
});

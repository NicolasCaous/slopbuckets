import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAMPLES, SAMPLE_VARIANTS } from '../testing/samples.js';
import {
  BUCKET_KEYS,
  BUCKET_NAME_PATTERN,
  BUCKET_REQUIRED_KEYS,
  CONFIG_KEYS,
  CONFIG_REQUIRED_KEYS,
  CONFIG_VERSION,
  SCHEMA_URL,
  configVersionStatus,
  packageKey,
  publicFiles,
} from './config.js';
import { HOOK_PHASES, PHASE_DECISIONS } from './hooks.js';
import { ADVICE, ADVICE_IDS, EXIT_CODES, RULES, RULE_IDS, reasonAdvice } from './rules.js';
import { groupUnowned, sortViolations, violationBuckets, violationKey, violationLocation, type Violation } from './violation.js';

const schema = JSON.parse(readFileSync(new URL('../../../site/schema/v2.json', import.meta.url), 'utf8'));

describe('config types', () => {
  it('match site/schema/v2.json', () => {
    expect(schema.$id).toBe(SCHEMA_URL);
    expect(Object.keys(schema.properties)).toEqual([...CONFIG_KEYS]);
    expect(schema.required).toEqual([...CONFIG_REQUIRED_KEYS]);
    expect(Object.keys(schema.$defs.bucket.properties)).toEqual([...BUCKET_KEYS]);
    expect(schema.$defs.bucket.required).toEqual([...BUCKET_REQUIRED_KEYS]);
    expect(schema.properties.buckets.propertyNames.pattern).toBe(BUCKET_NAME_PATTERN.source);
    expect(schema.$defs.bucket.properties.dependsOn.propertyNames.pattern).toBe(BUCKET_NAME_PATTERN.source);
  });

  it('accept one-line text and reject empty or multiline text', () => {
    const line = new RegExp(schema.$defs.line.pattern);
    expect(line.test('Issues and charges invoices')).toBe(true);
    for (const bad of ['', '   ', 'a\nb', 'a\r\nb']) expect(line.test(bad)).toBe(false);
    const publicPath = new RegExp(schema.$defs.publicPath.pattern);
    expect(publicPath.test('src/billing/index.ts')).toBe(true);
    expect(publicPath.test('src/billing/*.ts')).toBe(false);
    expect(schema.$defs.bucket.properties.public.oneOf.map((o: { type?: string }) => o.type ?? 'path')).toEqual(['path', 'array', 'null']);
  });

  it('take the config version from the schema pattern and read public in every form', () => {
    expect(new RegExp(schema.properties.version.pattern).test(CONFIG_VERSION)).toBe(true);
    expect(schema.properties.version.examples).toEqual([CONFIG_VERSION]);
    expect(publicFiles(null)).toEqual([]);
    expect(publicFiles('src/a/index.ts')).toEqual(['src/a/index.ts']);
    expect(publicFiles(['src/a/index.ts', 'src/a/server.ts'])).toEqual(['src/a/index.ts', 'src/a/server.ts']);
  });

  it('read 2.0, call a later minor or major newer, and reject the rest', () => {
    expect(['2.0'].map(configVersionStatus)).toEqual(['supported']);
    expect(['2.1', '3.0', '10.0'].map(configVersionStatus)).toEqual(['newer', 'newer', 'newer']);
    expect(['1.0', '2', '2.0.0', '02.0', 'v2.0', '', 2, null].map(configVersionStatus)).toEqual(Array(8).fill('invalid'));
  });

  it('turn a specifier into its packages key, and the schema pattern accepts every key', () => {
    const cases: [string, string][] = [
      ['lodash', 'lodash'],
      ['lodash/merge', 'lodash'],
      ['@scope/pkg', '@scope/pkg'],
      ['@scope/pkg/sub/path', '@scope/pkg'],
      ['fs', 'node:fs'],
      ['fs/promises', 'node:fs'],
      ['node:fs', 'node:fs'],
      ['node:fs/promises', 'node:fs'],
      ['node:test', 'node:test'],
    ];
    const key = new RegExp(schema.$defs.bucket.properties.packages.propertyNames.pattern);
    for (const [specifier, expected] of cases) {
      expect(packageKey(specifier), specifier).toBe(expected);
      expect(key.test(expected), expected).toBe(true);
    }
    expect(key.test('lodash/merge')).toBe(false);
  });
});

describe('rules', () => {
  it('interrupt in pre-tool only for config-invalid', () => {
    expect(RULE_IDS.filter((r) => RULES[r].preTool === 'interrupt')).toEqual(['config-invalid']);
    expect(Object.keys(RULES)).toEqual([...RULE_IDS]);
  });

  it('give each hook phase its decisions', () => {
    expect(Object.keys(PHASE_DECISIONS)).toEqual([...HOOK_PHASES]);
  });

  it('keep advice apart from the rules', () => {
    expect(Object.keys(ADVICE)).toEqual([...ADVICE_IDS]);
    expect(ADVICE_IDS.filter((id) => (RULE_IDS as readonly string[]).includes(id))).toEqual([]);
  });

  it('give a usage error its own exit code', () => {
    expect(EXIT_CODES).toEqual({ ok: 0, violations: 1, environment: 3, usage: 64 });
  });
});

describe('reasonAdvice', () => {
  const names = ['billing', 'log', 'payments'];
  it('flags a bucket name with a generic verb', () => {
    for (const text of ['Uses log', 'Needs log.', 'depends on log', 'Calls the log', 'imports payments and log', 'Billing']) expect(reasonAdvice(text, names), text).toBe('generic');
  });

  it('flags fewer than three words, and passes a reason that says what and why', () => {
    expect(reasonAdvice('Logs charges', names)).toBe('short');
    expect(reasonAdvice('Logs failed charges', names)).toBeNull();
    expect(reasonAdvice('Logs failed charges with the invoice id', names)).toBeNull();
    expect(reasonAdvice('Uses log to record failed charges', names)).toBeNull();
  });
});

describe('violationKey', () => {
  it('ignores the line where the file and target identify the problem', () => {
    const v = SAMPLES['import-ignored'];
    expect(violationKey({ ...v, line: 99 })).toBe(violationKey(v));
    expect(violationKey({ ...v, target: 'scripts/other.ts' })).not.toBe(violationKey(v));
    expect(violationKey({ ...v, project: 'packages/sdk' })).not.toBe(violationKey(v));
  });

  it('keys a grouped violation by its pair, so a new import in the group keeps the key', () => {
    const v = SAMPLES['import-private'];
    const more = { ...v, imports: [...v.imports, { file: 'src/billing/tax.ts', line: 1, target: 'src/payments/fees.ts', names: [] }] };
    expect(violationKey(more)).toBe(violationKey(v));
    expect(violationKey({ ...v, to: 'log' })).not.toBe(violationKey(v));
    const d = SAMPLES['dependency-undeclared'];
    expect(violationKey({ ...d, imports: [...d.imports, { ...d.imports[0]!, line: 40 }] })).toBe(violationKey(d));
  });

  it('gives the same key to every rotation of a cycle', () => {
    const k = (cycle: string[]) => violationKey({ rule: 'config-cycle', project: '.', cycle, edges: [] });
    expect(k(['payments', 'tax', 'billing'])).toBe(k(['billing', 'payments', 'tax']));
    expect(k(['billing', 'tax', 'payments'])).not.toBe(k(['billing', 'payments', 'tax']));
  });

  it('is unique across the samples', () => {
    for (const list of [Object.values(SAMPLES) as Violation[], SAMPLE_VARIANTS]) expect(new Set(list.map(violationKey)).size).toBe(list.length);
  });
});

describe('violationLocation and violationBuckets', () => {
  it('point at the file of each rule', () => {
    expect(Object.fromEntries(RULE_IDS.map((r) => [r, violationLocation(SAMPLES[r])]))).toEqual({
      'config-invalid': { file: 'buckets.config.json' },
      'config-cycle': { file: 'buckets.config.json' },
      'dependency-undeclared': { file: 'src/billing/invoice.ts', line: 3 },
      'dependency-unused': { file: 'buckets.config.json' },
      'import-private': { file: 'src/billing/invoice.ts', line: 3 },
      'import-unresolved': { file: 'src/billing/invoice.ts', line: 4 },
      'import-ignored': { file: 'src/billing/invoice.ts', line: 5 },
      'import-dynamic': { file: 'src/billing/load.ts', line: 9 },
      'import-namespace': { file: 'src/billing/invoice.ts', line: 2 },
      'file-unowned': { file: 'src/utils/date.ts' },
      'file-overlap': { file: 'src/billing/stripe/charge.ts' },
      'glob-empty': { file: 'buckets.config.json' },
      'public-missing': { file: 'src/payments/api.ts' },
      'public-not-interface': { file: 'src/payments/index.ts', line: 4 },
      'project-undeclared': { file: 'packages/sdk/buckets.config.json' },
      'export-unused': { file: 'src/payments/index.ts', line: 4 },
      'package-undeclared': { file: 'src/billing/invoice.ts', line: 6 },
      'package-unused': { file: 'buckets.config.json' },
    });
    expect(violationLocation(SAMPLE_VARIANTS.find((v) => v.rule === 'file-unowned' && 'noBuckets' in v)!)).toEqual({ file: 'buckets.config.json' });
    expect(violationBuckets(SAMPLES['config-invalid'])).toEqual(['billing']);
    expect(violationBuckets(SAMPLES['file-overlap'])).toEqual(['billing', 'stripe']);
  });

  it('sort by project, file and line', () => {
    const sorted = sortViolations([{ ...SAMPLES['import-dynamic'], project: 'packages/sdk' }, SAMPLES['import-ignored'], SAMPLES['import-namespace']]);
    expect(sorted.map((v) => [v.project, violationLocation(v).line])).toEqual([
      ['.', 2],
      ['.', 5],
      ['packages/sdk', 9],
    ]);
  });
});

describe('groupUnowned', () => {
  it('groups the topmost folder whose files are all unowned', () => {
    const legacy = Array.from({ length: 6 }, (_, i) => `src/legacy/deep/f${i}.ts`).concat('src/legacy/x.ts');
    const all = [...legacy, 'src/utils/date.ts', 'src/utils/owned.ts', 'src/utils/o2.ts', 'src/utils/o3.ts', 'root.ts', 'src/a/1.ts', 'src/a/2.ts'];
    expect(groupUnowned('.', [...legacy, 'src/utils/date.ts', 'root.ts', 'src/a/1.ts', 'src/a/2.ts'], all, 5)).toEqual([
      { rule: 'file-unowned', project: '.', file: 'root.ts' },
      { rule: 'file-unowned', project: '.', file: 'src/a/1.ts' },
      { rule: 'file-unowned', project: '.', file: 'src/a/2.ts' },
      { rule: 'file-unowned', project: '.', folder: 'src/legacy/**', count: 7 },
      { rule: 'file-unowned', project: '.', file: 'src/utils/date.ts' },
    ]);
  });

  it('never groups a top folder that has subfolders, nor a folder that only wraps one subfolder', () => {
    const all = Array.from({ length: 30 }, (_, i) => `src/m${i % 3}/f${i}.ts`);
    expect(groupUnowned('.', all, all)).toEqual([
      { rule: 'file-unowned', project: '.', folder: 'src/m0/**', count: 10 },
      { rule: 'file-unowned', project: '.', folder: 'src/m1/**', count: 10 },
      { rule: 'file-unowned', project: '.', folder: 'src/m2/**', count: 10 },
    ]);
    const wrapped = Array.from({ length: 12 }, (_, i) => `packages/web/src/${i % 2 ? 'app' : 'lib'}/f${i}.ts`);
    expect(groupUnowned('.', wrapped, wrapped).map((v) => ('folder' in v ? v.folder : ''))).toEqual(['packages/web/src/app/**', 'packages/web/src/lib/**']);
    const flat = Array.from({ length: 6 }, (_, i) => `scripts/s${i}.ts`);
    expect(groupUnowned('.', flat, flat)).toEqual([{ rule: 'file-unowned', project: '.', folder: 'scripts/**', count: 6 }]);
  });

  it('splits a folder that holds more than half of the files one level down', () => {
    const big = Array.from({ length: 8 }, (_, i) => `src/components/${i % 2 ? 'ui' : 'forms'}/f${i}.ts`).concat('src/components/index.ts');
    const all = [...big, 'src/lib/a.ts', 'src/lib/b.ts', 'src/i18n/c.ts'];
    expect(groupUnowned('.', all, all, 1).map((v) => ('folder' in v ? `${v.folder} ${v.count}` : 'file' in v ? v.file : ''))).toEqual([
      'src/components/forms/** 4',
      'src/components/index.ts',
      'src/components/ui/** 4',
      'src/i18n/** 1',
      'src/lib/** 2',
    ]);
  });

  it('gives one no-buckets violation with the folders at the level of siblings', () => {
    const files = ['next.config.ts', 'src/middleware.ts', 'src/app/a.ts', 'src/app/b/c.ts', 'src/lib/x.ts', 'scripts/build.ts'];
    expect(groupUnowned('.', files, files, 5, true)).toEqual([
      {
        rule: 'file-unowned',
        project: '.',
        noBuckets: true,
        count: 6,
        folders: [
          { folder: 'scripts/**', count: 1 },
          { folder: 'src/app/**', count: 2 },
          { folder: 'src/lib/**', count: 1 },
        ],
        files: ['next.config.ts', 'src/middleware.ts'],
      },
    ]);
    expect(groupUnowned('.', [], files, 5, true)).toEqual([]);
  });
});

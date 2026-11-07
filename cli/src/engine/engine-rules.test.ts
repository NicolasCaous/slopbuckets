// Each rule of the engine fires on a small project, alone.
import { afterEach, describe, expect, it } from 'vitest';
import type { RuleId } from '../contract/rules.js';
import { cleanupProjects } from '../testing/fixture.js';
import { BASE_FILES, baseConfig, bucket, check, rules } from './engine-test-kit.js';

afterEach(cleanupProjects);

describe('each rule fires', () => {
  const cases: [string, RuleId[], Record<string, string>, object?][] = [
    ['dependency-undeclared', ['dependency-undeclared'], BASE_FILES, baseConfig((c) => (c.buckets.billing.dependsOn = {}))],
    ['dependency-unused', ['dependency-unused', 'export-unused'], { ...BASE_FILES, 'src/billing/main.ts': 'export {};\n' }],
    ['import-private (file)', ['import-private'], { ...BASE_FILES, 'src/billing/main.ts': "import { charge } from '../payments/charge';\nconsole.log(charge);\n" }],
    ['import-private (closed bucket)', ['import-private'], { ...BASE_FILES, 'src/billing/main.ts': "import { charge } from '../payments/charge';\nconsole.log(charge);\n" }, baseConfig((c) => (c.buckets.payments.public = null))],
    ['import-ignored', ['import-ignored'], { ...BASE_FILES, 'scripts/env.ts': 'export const env = 1;\n', 'src/billing/env.ts': "import { env } from '../../scripts/env';\nconsole.log(env);\n" }, baseConfig((c) => (c.ignore = ['scripts/**']))],
    ['import-dynamic (import)', ['import-dynamic'], { ...BASE_FILES, 'src/billing/lazy.ts': 'export const load = (n: string) => import(n);\n' }],
    ['import-dynamic (require)', ['import-dynamic'], { ...BASE_FILES, 'src/billing/lazy.cjs': 'const name = "x";\nmodule.exports = require(name);\n' }],
    ['import-namespace (import *)', ['export-unused', 'import-namespace'], { ...BASE_FILES, 'src/billing/main.ts': "import * as p from '../payments';\nconsole.log(p);\n" }],
    ['import-namespace (import())', ['export-unused', 'import-namespace'], { ...BASE_FILES, 'src/billing/main.ts': "export const p = () => import('../payments');\n" }],
    ['file-unowned', ['file-unowned'], { ...BASE_FILES, 'src/stray.ts': 'export const s = 1;\n' }],
    ['file-overlap', ['file-overlap'], BASE_FILES, baseConfig((c) => c.buckets.billing.files.push('src/payments/charge.ts'))],
    ['glob-empty (files)', ['glob-empty'], BASE_FILES, baseConfig((c) => c.buckets.billing.files.push('src/nothing/**'))],
    ['glob-empty (exclusion)', ['glob-empty'], BASE_FILES, baseConfig((c) => c.buckets.billing.files.push('!src/billing/zzz/**'))],
    ['glob-empty (ignore)', ['glob-empty'], BASE_FILES, baseConfig((c) => (c.ignore = ['nope/**']))],
    ['glob-empty (projects)', ['glob-empty'], BASE_FILES, baseConfig((c) => (c.projects = ['packages/none']))],
    ['public-missing (not found)', ['import-private', 'public-missing'], BASE_FILES, baseConfig((c) => (c.buckets.payments.public = 'src/payments/api.ts'))],
    ['public-missing (other bucket)', ['import-private', 'public-missing'], BASE_FILES, baseConfig((c) => (c.buckets.payments.public = 'src/billing/main.ts'))],
    ['public-not-interface (code)', ['export-unused', 'public-not-interface'], { ...BASE_FILES, 'src/payments/index.ts': "export { charge } from './charge';\nexport const fee = 1;\n" }],
    ['public-not-interface (export *)', ['public-not-interface'], { ...BASE_FILES, 'src/payments/index.ts': "export * from './charge';\n" }],
    [
      'public-not-interface (foreign re-export)',
      ['dependency-undeclared', 'public-not-interface'],
      { ...BASE_FILES, 'src/billing/util.ts': 'export const u = 1;\n', 'src/payments/index.ts': "export { charge } from './charge';\nexport { u } from '../billing/util';\n", 'src/billing/main.ts': "import { charge, u } from '../payments';\nconsole.log(charge, u);\n" },
    ],
    [
      'no public-not-interface for an external bucket that re-exports a dependency by name',
      ['import-private'],
      { ...BASE_FILES, 'src/sdk/index.ts': "export { charge } from '../payments/charge';\n" },
      baseConfig((c) => (c.buckets.sdk = bucket('sdk', { dependsOn: { payments: 'Offers the gateway calls to users' }, external: 'Entry point of the npm package' }))),
    ],
    ['project-undeclared', ['project-undeclared'], { ...BASE_FILES, 'packages/sdk/buckets.config.json': '{ "buckets": {} }\n' }],
    ['export-unused', ['export-unused'], { ...BASE_FILES, 'src/payments/index.ts': "export { charge, refund } from './charge';\n", 'src/payments/charge.ts': 'export const charge = 1;\nexport const refund = 2;\n' }],
    ['config-cycle', ['config-cycle', 'dependency-unused'], BASE_FILES, baseConfig((c) => (c.buckets.payments.dependsOn = { billing: 'Calls back' }))],
  ];
  it.each(cases)('%s', async (_name, expected, files, config) => {
    expect(rules(await check(files, config))).toEqual(expected);
  });
});

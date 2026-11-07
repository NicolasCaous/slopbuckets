// Helpers of the engine tests: a two-bucket project, written and committed in a temporary folder.
import { execFileSync } from 'node:child_process';
import type { CheckResult } from '../contract/engine.js';
import { violationKey, type Violation } from '../contract/violation.js';
import { makeProject } from '../testing/fixture.js';
import { createEngine } from './engine.js';

export const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true, paths: { '@p/*': ['./src/payments/*'] } } });

export interface BucketSpec {
  purpose?: string;
  files?: string[];
  public?: string | string[] | null;
  dependsOn?: Record<string, string>;
  packages?: Record<string, string>;
  external?: string;
}

export const bucket = (name: string, spec: BucketSpec = {}) => ({
  purpose: spec.purpose ?? `Keeps the ${name} rules and records`,
  files: spec.files ?? [`src/${name}/**`],
  public: spec.public === undefined ? `src/${name}/index.ts` : spec.public,
  dependsOn: spec.dependsOn ?? {},
  packages: spec.packages ?? {},
  ...(spec.external ? { external: spec.external } : {}),
});

/** A clean project: billing (closed) imports charge from the public file of payments. */
export function baseConfig(change: (c: any) => void = () => {}) {
  const config: any = {
    version: '2.0',
    buckets: {
      billing: bucket('billing', { public: null, dependsOn: { payments: 'Charges go through the gateway' } }),
      payments: bucket('payments'),
    },
  };
  change(config);
  return config;
}
export const BASE_FILES: Record<string, string> = {
  'src/payments/index.ts': "export { charge } from './charge';\n",
  'src/payments/charge.ts': 'export const charge = (n: number) => n;\n',
  'src/billing/main.ts': "import { charge } from '../payments';\nconsole.log(charge(1));\n",
};

export function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** Writes the project, commits it, and returns its folder. */
export function project(files: Record<string, string>, config: object | string = baseConfig(), options: { git?: boolean; tsconfig?: boolean } = {}): string {
  const all: Record<string, string> = { 'buckets.config.json': typeof config === 'string' ? config : JSON.stringify(config, null, 2), ...files };
  if (options.tsconfig !== false) all['tsconfig.json'] ??= TSCONFIG;
  const dir = makeProject(all);
  if (options.git !== false) {
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  }
  return dir;
}

export const engine = () => createEngine({ cliVersion: 'test' });
export const rules = (r: CheckResult | Violation[]) => (Array.isArray(r) ? r : r.violations).map((v) => v.rule).sort();
export const keys = (list: Violation[]) => list.map(violationKey).sort();

export async function check(files: Record<string, string>, config?: object | string): Promise<CheckResult> {
  return engine().checkAll(project(files, config));
}

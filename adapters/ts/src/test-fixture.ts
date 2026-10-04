// Fixture projects for the unit tests. They live in adapters/ts/.test-tmp/ so that
// the repository's own `typescript` package resolves from them. Each test process
// gets its own run-<pid>-<time>-<random>/ folder there, so overlapping test runs
// never remove each other's files.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './env.js';
import type { AnalyzeRequest, BucketsConfig } from './protocol.js';

export const TMP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.test-tmp',
  `run-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
);

/** Removes this process's run folder and .test-tmp/ when nothing else is left in them. */
export function removeEmptyRunFolder(): void {
  for (const dir of [TMP_ROOT, path.dirname(TMP_ROOT)]) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty: another fixture, or another test process, still uses it.
    }
  }
}

export const CONFIG: BucketsConfig = { root: 'root', alias: '@root', maxDepth: 2 };

export const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noUnusedLocals: true,
    skipLibCheck: true,
    types: [],
    paths: { '@root/*': ['./root/*'] },
  },
};

export const PACKAGE_JSON = {
  name: 'fixture',
  private: true,
  dependencies: { axios: '^1.0.0' },
  devDependencies: { '@nestjs/core': '^10.0.0' },
  peerDependencies: { react: '^19.0.0' },
  optionalDependencies: { 'left-pad': '^1.0.0' },
};

export class Fixture {
  readonly dir: string;

  constructor(files: Record<string, string | object>, options: { base?: string; tsconfig?: boolean; packageJson?: boolean } = {}) {
    const base = options.base ?? TMP_ROOT;
    mkdirSync(base, { recursive: true });
    this.dir = mkdtempSync(path.join(base, 'fixture-'));
    const defaults: Record<string, string | object> = {};
    if (options.tsconfig !== false) defaults['tsconfig.json'] = TSCONFIG;
    if (options.packageJson !== false) defaults['package.json'] = PACKAGE_JSON;
    this.write({ ...defaults, ...files });
  }

  write(files: Record<string, string | object>): void {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(this.dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    }
  }

  read(name: string): string {
    return readFileSync(path.join(this.dir, name), 'utf8');
  }

  json(name: string): Record<string, any> {
    return JSON.parse(this.read(name)) as Record<string, any>;
  }

  /** Parses a file that may hold comments and trailing commas, as tsconfig.json may. */
  jsonc(name: string): Record<string, any> {
    const ts = loadTypeScript(this.dir);
    const { config, error } = ts.parseConfigFileTextToJson(name, this.read(name));
    if (error !== undefined) throw new Error(`${name} does not parse: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
    return config as Record<string, any>;
  }

  request(dmz: string[], code: string[]): AnalyzeRequest {
    return { abi: 1, config: CONFIG, files: { dmz, code } };
  }

  remove(): void {
    // Retries cover Windows, where a handle can stay open for a moment after the compiler or a child process lets go.
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // A folder that still cannot go stays in this process's run folder, which is scratch space.
    }
    removeEmptyRunFolder();
  }
}

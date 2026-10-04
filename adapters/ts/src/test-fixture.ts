// Fixture projects for the unit tests. They live in adapters/ts/.test-tmp/ so that
// the repository's own `typescript` package resolves from them. Each test file
// gets its own run-<pid>-<time>-<random>/ folder there, so overlapping test runs
// never remove each other's files.
//
// The run folder stays until the test file ends, and .test-tmp/ stays until the
// whole run ends (see test-global-setup.ts). Removing either one while a test
// still creates folders in it fails on Windows: a folder that was just removed can
// linger for a moment while another program holds a handle on it, and creating
// anything inside it then fails with EPERM.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { loadTypeScript } from './env.js';
import type { AnalyzeRequest, BucketsConfig } from './protocol.js';

export const TMP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.test-tmp',
  `run-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
);

// Registered when a test file imports this module, so it runs once at the end of that file, after its own hooks.
afterAll(() => removeFolder(TMP_ROOT));

/** Errors Windows returns for a moment while an antivirus or indexer scans a file or folder that was just created. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'UNKNOWN']);

/** Runs `action` again, up to 5 times with a growing pause, while it fails with one of the TRANSIENT errors. */
function retry<T>(action: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (error) {
      if (attempt >= 5 || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

/** Creates a new folder named `prefix` plus random characters inside `base`, creating `base` first when needed. */
export function makeTempDir(base: string, prefix: string): string {
  retry(() => mkdirSync(base, { recursive: true }));
  return retry(() => mkdtempSync(path.join(base, prefix)));
}

/** Removes a scratch folder. One that still cannot go after the retries stays, since .test-tmp/ is gitignored. */
export function removeFolder(dir: string): void {
  // Retries cover Windows, where a handle can stay open for a moment after the compiler or a child process lets go.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Left for a later run to ignore.
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
    this.dir = makeTempDir(options.base ?? TMP_ROOT, 'fixture-');
    const defaults: Record<string, string | object> = {};
    if (options.tsconfig !== false) defaults['tsconfig.json'] = TSCONFIG;
    if (options.packageJson !== false) defaults['package.json'] = PACKAGE_JSON;
    this.write({ ...defaults, ...files });
  }

  write(files: Record<string, string | object>): void {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(this.dir, name);
      retry(() => mkdirSync(path.dirname(file), { recursive: true }));
      retry(() => writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`));
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

  /** Removes the fixture folder. The run folder itself goes when the test file ends. */
  remove(): void {
    removeFolder(this.dir);
  }
}

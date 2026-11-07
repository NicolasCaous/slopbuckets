// Fixture projects for the unit tests of the adapter, in a run folder of test-support.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadTypeScript } from './env.js';
import type { AnalyzeRequest } from './protocol.js';
import { makeTempDir, removeFolder, retry, runFolder } from './test-support.js';

export const TMP_ROOT = runFolder();

export const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
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
    const { ts } = loadTypeScript(this.dir);
    const { config, error } = ts.parseConfigFileTextToJson(name, this.read(name));
    if (error !== undefined) throw new Error(`${name} does not parse: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
    return config as Record<string, any>;
  }

  request(files: string[]): AnalyzeRequest {
    return { abi: 2, files };
  }

  /** Removes the fixture folder. The run folder itself goes when the test file ends. */
  remove(): void {
    removeFolder(this.dir);
  }
}

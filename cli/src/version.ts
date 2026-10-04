import { readFileSync } from 'node:fs';

// Both cli/src/version.ts (tests, API) and the bundled cli/dist/index.js sit one level below cli/package.json.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const CLI_VERSION: string = pkg.version;

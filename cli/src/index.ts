// Entry of the `buckets` binary. It turns on the V8 compile cache before the rest of the CLI is compiled, so later
// runs (every hook call is a new process) load the bundle and typescript from cached code. Then it loads cli.ts.
import module from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.env.NODE_DISABLE_COMPILE_CACHE) module.enableCompileCache?.();
const { run } = await import('./cli.js');
// src/index.ts and the bundled dist/index.js both sit one level below the package.json.
await run(fileURLToPath(new URL('..', import.meta.url)), process.argv.slice(2));

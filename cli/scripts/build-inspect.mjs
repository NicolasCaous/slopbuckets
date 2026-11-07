// Bundles the inspect page (src/inspect/page/main.ts and what it imports) into dist/inspect-page.js, plus
// dist/inspect-page.css when the page imports CSS. The server serves these files and `--export html` inlines them.
// The graph worker, src/inspect/graph/worker.ts, is bundled first and reaches the page as the string constant
// __INSPECT_WORKER__. The page starts it from a blob: URL, which works on the server and in the offline export alike.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(cli, 'src/inspect/page/main.ts');
const worker = path.join(cli, 'src/inspect/graph/worker.ts');
const common = { bundle: true, minify: true, format: 'iife', target: 'es2022', platform: 'browser', legalComments: 'none', logLevel: 'warning' };

const workerBuild = await build({ ...common, entryPoints: [worker], write: false });

await build({
  ...common,
  entryPoints: { 'inspect-page': entry },
  outdir: path.join(cli, 'dist'),
  define: { __INSPECT_WORKER__: JSON.stringify(workerBuild.outputFiles[0].text) },
});

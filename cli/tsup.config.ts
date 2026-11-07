import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  // index.ts turns on the V8 compile cache and then imports cli.ts, so the code it loads is a separate chunk.
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  splitting: true,
  // The TypeScript adapter is a private workspace package, so it ships inside the CLI bundle.
  noExternal: ['@slopbuckets/adapter-ts'],
  // The adapter loads the project's `typescript` at runtime, or else the `typescript` 6 dependency installed next to
  // slopbuckets, so neither is bundled.
  external: ['typescript'],
  banner: { js: '#!/usr/bin/env node' },
  esbuildPlugins: [
    {
      // `import text from './file.js?raw'` is the text of the file, as in vitest. The plugin files of
      // src/hooks/plugins/ are real JavaScript that init writes into a project.
      name: 'raw',
      setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.join(args.resolveDir, args.path.slice(0, -'?raw'.length)), namespace: 'raw' }));
        build.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
      },
    },
  ],
});

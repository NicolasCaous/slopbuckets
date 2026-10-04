import { writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { defineConfig } from 'tsup';
import { buildStaticBundle, STATIC_BUNDLE_FILE } from './src/web/static-bundle.js';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  // The TypeScript adapter is a private workspace package, so it ships inside the CLI bundle.
  noExternal: ['@slopbuckets/adapter-ts'],
  // The adapter loads `typescript` from the user's project at runtime, so it must never be bundled. `esbuild` is only
  // loaded when the CLI runs from its source, to build the browser script below on the fly.
  external: ['typescript', 'esbuild'],
  banner: { js: '#!/usr/bin/env node' },
  // The browser script of `inspect --export html`, next to index.js, which reads it when it exports.
  async onSuccess() {
    writeFileSync(`dist/${STATIC_BUNDLE_FILE}`, await buildStaticBundle(esbuild.build, 'src/web/inspect-static-entry.ts'));
  },
});

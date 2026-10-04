import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['adapters/*/src/**/*.test.ts', 'cli/src/**/*.test.ts'],
          // Many unit tests build a TypeScript program, run git or start a local server. One takes 1 to 3 seconds
          // alone, and more than 5 seconds (the vitest default) when other test runs or a build share the machine.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Removes the shared .test-tmp/ folders once every test file is done. See cli/src/testing/fixture.ts.
          globalSetup: ['cli/src/testing/global-setup.ts', 'adapters/ts/src/test-global-setup.ts'],
        },
      },
      {
        test: {
          name: 'examples',
          include: ['examples/*.test.ts'],
          testTimeout: 60_000,
        },
      },
    ],
  },
});

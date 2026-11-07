// Vitest global setup for the unit tests of both packages. Its teardown runs once, after every test file of the run
// has finished, and removes the bases of test-support.ts when they are empty. The test files share them, so none of
// them may remove one on its own: another file running in parallel may be creating its run folder there.
import { rmdirSync } from 'node:fs';
import { OUTSIDE_BASE, TMP_BASE } from './test-support.js';

export default function setup(): () => void {
  return () => {
    for (const base of [TMP_BASE, OUTSIDE_BASE]) {
      try {
        rmdirSync(base);
      } catch {
        // Missing, or not empty because another test run on this machine still uses it.
      }
    }
  };
}

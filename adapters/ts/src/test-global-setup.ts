// Vitest global setup for the unit tests. Its teardown runs once, after every test file of the run has finished, and
// removes adapters/ts/.test-tmp/ when it is empty. The test files share that folder, so none of them may remove it on
// its own: another file running in parallel may be creating its run folder there at the same moment.

import { rmdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');

export default function setup(): () => void {
  return () => {
    try {
      rmdirSync(TMP_BASE);
    } catch {
      // Missing, or not empty because another test run on this machine still uses it.
    }
  };
}

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configHash, parseConfig } from './config.js';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
/** The buckets.config.json files under the cases of examples/, without the scratch copies of the battery. */
function findConfigs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.tmp' || entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) findConfigs(file, out);
    else if (entry.name === 'buckets.config.json') out.push(path.relative(EXAMPLES, file));
  }
  return out;
}
const configs = findConfigs(EXAMPLES).sort();

describe('parseConfig', () => {
  it('finds the configs of the examples', () => {
    expect(configs.length).toBeGreaterThan(100);
  });

  // The trusted path skips the checks for a text the cache already accepted. Both paths build the Config with toConfig.
  it('gives the same Config on the trusted path as on the validated one, for every example config', () => {
    let valid = 0;
    for (const file of configs) {
      const text = readFileSync(path.join(EXAMPLES, file), 'utf8');
      const checked = parseConfig(text);
      if (!('config' in checked)) continue;
      valid++;
      expect(parseConfig(text, configHash(text)), file).toEqual(checked);
    }
    expect(valid).toBeGreaterThan(100);
  });
});

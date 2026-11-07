// node --test "scripts/bench/*.test.mjs"
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate, parseArgs, PRESETS, RULES } from '../stress-project.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(path.join(repo, 'site', 'schema', 'v2.json'), 'utf8'));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'stress-project-test-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
let n = 0;
const out = () => path.join(tmp, `p${n++}`);
const git = (root, ...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const config = (root) => JSON.parse(readFileSync(path.join(root, 'buckets.config.json'), 'utf8'));
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** The subset of JSON Schema that v2.json uses: type, required, properties, additionalProperties, propertyNames,
 * items, minItems, minLength, pattern, oneOf and $ref. Returns error strings. */
function validate(s, value, at = '$') {
  if (s.$ref) s = { ...s.$ref.split('/').slice(1).reduce((x, k) => x[k], schema), ...s, $ref: undefined };
  if (s.oneOf) {
    const matches = s.oneOf.filter((x) => validate(x, value, at).length === 0).length;
    return matches === 1 ? [] : [`${at}: matches ${matches} schemas of oneOf`];
  }
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (s.type && s.type !== type) return [`${at}: expected ${s.type}, got ${type}`];
  const errors = [];
  if (type === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${at}: "${value}" does not match ${s.pattern}`);
  }
  if (type === 'array') {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
    if (s.items) value.forEach((v, i) => errors.push(...validate(s.items, v, `${at}[${i}]`)));
  }
  if (type === 'object') {
    for (const k of s.required ?? []) if (!(k in value)) errors.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (s.propertyNames) errors.push(...validate(s.propertyNames, k, `${at} key ${k}`));
      if (s.properties?.[k]) errors.push(...validate(s.properties[k], v, `${at}.${k}`));
      else if (s.additionalProperties === false) errors.push(`${at}: unknown key ${k}`);
      else if (typeof s.additionalProperties === 'object') errors.push(...validate(s.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errors;
}

/** What the schema cannot say: dependsOn names real buckets, and the dependency graph has a cycle or not. */
function graphFacts(cfg) {
  const names = new Set(Object.keys(cfg.buckets));
  const missing = Object.values(cfg.buckets).flatMap((b) => Object.keys(b.dependsOn).filter((d) => !names.has(d)));
  const state = new Map();
  const cyclic = (b) => {
    if (state.get(b) === 1) return true;
    if (state.get(b) === 2 || !names.has(b)) return false;
    state.set(b, 1);
    const found = Object.keys(cfg.buckets[b].dependsOn).some(cyclic);
    state.set(b, 2);
    return found;
  };
  return { missing, cycle: [...names].some(cyclic) };
}

describe('stress-project', () => {
  test('the same options give the same commit, another seed another one', () => {
    const a = generate({ ...PRESETS.tiny, out: out() });
    const b = generate({ ...PRESETS.tiny, out: out() });
    const c = generate({ ...PRESETS.tiny, seed: 2, out: out() });
    assert.equal(a.head, b.head);
    assert.deepEqual(a.files, b.files);
    assert.notEqual(a.head, c.head);
  });

  const shaped = { files: 400, buckets: 20, fanout: 3, chain: 6, hub: 10, excludeEvery: 5, bigFile: true, extendsDepth: 3, workspace: 'pnpm', hostileNames: true, nested: true };

  test('file count, git state and the shapes the options ask for', () => {
    const r = generate({ ...shaped, out: out() });
    assert.equal(r.files.length, 400);
    const tracked = git(r.root, 'ls-files', '-z').split('\0').filter((f) => SOURCE.test(f));
    assert.deepEqual(tracked.sort(), r.files);
    assert.equal(git(r.root, 'status', '--porcelain'), '');
    assert.equal(git(r.root, 'rev-list', '--count', 'HEAD').trim(), '1');

    const cfg = config(r.root);
    const b = cfg.buckets;
    assert.equal(Object.keys(b).length, 20);
    for (let i = 0; i < 5; i++) assert.ok(b[`b${String(i).padStart(2, '0')}`].dependsOn[`b${String(i + 1).padStart(2, '0')}`], `chain link ${i}`);
    assert.ok(Object.values(b).filter((x) => x.dependsOn.b19).length >= 10, 'hub dependents');
    assert.ok(Object.values(b).some((x) => x.files.some((g) => g.startsWith('!'))), 'a ! exclusion');
    assert.ok(r.files.some((f) => / /.test(f) && /[A-Z]/.test(f)), 'a path with a space and uppercase');
    assert.deepEqual(cfg.projects, ['nested/sdk']);
    assert.ok(existsSync(path.join(r.root, 'nested', 'sdk', 'buckets.config.json')));
    assert.ok(existsSync(path.join(r.root, 'pnpm-workspace.yaml')));
    const pkgs = Object.values(b).filter((x) => x.files[0].startsWith('packages/'));
    assert.equal(pkgs.length, 2);
    for (const p of pkgs) {
      const name = p.files[0].split('/')[1];
      assert.equal(JSON.parse(readFileSync(path.join(r.root, 'node_modules', '@acme', name, 'package.json'), 'utf8')).name, `@acme/${name}`);
    }
    const big = readFileSync(path.join(r.root, r.files.find((f) => f.endsWith('big-table.ts'))), 'utf8').split('\n');
    assert.equal(big.length - 1, 20000);
    assert.equal(big.filter((l) => l.startsWith('import ')).length, 400);
    let ts = JSON.parse(readFileSync(path.join(r.root, 'tsconfig.json'), 'utf8'));
    let depth = 0;
    for (let dir = r.root; ts.extends; depth++) {
      const file = path.join(dir, ts.extends);
      dir = path.dirname(file);
      ts = JSON.parse(readFileSync(file, 'utf8'));
    }
    assert.equal(depth, 3);
  });

  test('configs follow site/schema/v2.json; cycles and missing buckets only when asked', () => {
    const all = Object.fromEntries(RULES.filter((x) => x !== 'config-invalid' && x !== 'config-cycle').map((x) => [x, 2]));
    for (const opts of [{ ...shaped, violations: all }, { ...PRESETS.shop }]) {
      const cfg = config(generate({ ...opts, out: out() }).root);
      assert.deepEqual(validate(schema, cfg), []);
      assert.deepEqual(graphFacts(cfg), { missing: [], cycle: false });
    }
    const cyclic = config(generate({ ...PRESETS.tiny, violations: { 'config-cycle': 1 }, out: out() }).root);
    assert.equal(graphFacts(cyclic).cycle, true);
    const invalid = config(generate({ ...PRESETS.tiny, violations: { 'config-invalid': 2 }, out: out() }).root);
    assert.deepEqual(graphFacts(invalid).missing, ['missing-0', 'missing-1']);
  });

  test('the shop is the default of the command line', () => {
    const opts = parseArgs(['some/dir', '--git']);
    assert.equal(opts.shop, true);
    assert.equal(opts.out, 'some/dir');
    const r = generate({ ...opts, out: out() });
    const cfg = config(r.root);
    assert.equal(cfg.buckets.app.public, null);
    assert.equal(cfg.buckets.checkout.dependsOn.payments, 'Charges the customer');
    assert.deepEqual(cfg.projects, ['packages/storefront-sdk']);
    assert.deepEqual(Object.keys(r.violations).sort(), ['dependency-undeclared', 'dependency-unused', 'export-unused', 'file-unowned', 'import-private']);
  });

  test('parseArgs reads presets, flags and violations', () => {
    const o = parseArgs(['out', '--preset', '10k', '--files', '2000', '--workspace', 'none', '--violations', 'file-unowned=3,glob-empty']);
    assert.equal(o.files, 2000);
    assert.equal(o.buckets, 500);
    assert.equal(o.workspace, 'none');
    assert.equal(o.violations['file-unowned'], 3);
    assert.equal(o.violations['glob-empty'], 1);
    assert.equal(o.violations['config-cycle'], 1);
    assert.equal(parseArgs(['--files', '10']).shop, undefined);
    assert.throws(() => parseArgs(['--preset', 'huge']), /unknown preset/);
    assert.throws(() => parseArgs(['--files', 'many']), /whole number/);
    assert.throws(() => generate({ ...PRESETS.tiny, violations: { 'no-such-rule': 1 }, out: out() }), /unknown rule/);
  });

  test('RULES lists the rule ids of the contract', () => {
    const text = readFileSync(path.join(repo, 'cli', 'src', 'contract', 'rules.ts'), 'utf8');
    const ids = [...text.match(/RULE_IDS = \[([^\]]*)\]/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...RULES].sort(), ids.sort());
  });

  // The clean project is clean and each injected count is exact under `buckets check --json`. config-invalid is left
  // out, because a broken config skips every other rule, and config-cycle gets one: the engine reports one cycle per
  // group of buckets that reach each other, and two injected cycles can share a bucket.
  const cli = path.join(repo, 'cli', 'dist', 'index.js');
  test('violation counts match buckets check', { skip: !existsSync(cli) && 'run npm run build first' }, () => {
    const counted = RULES.filter((r) => r !== 'config-invalid');
    const base = { files: 600, buckets: 30, fanout: 3, chain: 5, hub: 8, excludeEvery: 6, bigFile: true, workspace: 'npm', hostileNames: true };
    for (const count of [0, 2]) {
      const want = Object.fromEntries(counted.map((x) => [x, x === 'config-cycle' ? Math.min(count, 1) : count]));
      const r = generate({ ...base, violations: want, out: out() });
      symlinkSync(path.join(repo, 'node_modules', 'typescript'), path.join(r.root, 'node_modules', 'typescript'), 'junction');
      const p = spawnSync(process.execPath, [cli, 'check', '--json'], { cwd: r.root, encoding: 'utf8', env: { ...process.env, SLOPBUCKETS_NO_UPDATE_CHECK: '1' } });
      const result = JSON.parse(p.stdout);
      assert.deepEqual(result.environment, []);
      const found = {};
      for (const v of result.violations) found[v.rule] = (found[v.rule] ?? 0) + 1;
      assert.deepEqual(found, count ? want : {},JSON.stringify(result.violations, null, 1).slice(0, 4000));
    }
  });
});

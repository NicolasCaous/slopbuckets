import { describe, expect, it } from 'vitest';
import { classifyDmzPath, type DmzOwner } from './dmz-path.js';

const billing: DmzOwner = { path: 'root/billing', children: ['invoices', 'payments'], isRoot: false };
const root: DmzOwner = { path: 'root', children: ['log', 'billing'], isRoot: true };

function ok(owner: DmzOwner, rel: string): boolean {
  return !('error' in classifyDmzPath(owner, rel, '.ts'));
}

describe('DMZ path convention (SPEC table for billing/dmz/)', () => {
  it.each([
    ['payments/invoices.ts', 'what invoices consumes from payments'],
    ['.self/invoices.ts', 'what invoices consumes from billing/_'],
    ['invoices/.self.ts', 'what billing/_ consumes from invoices'],
    ['.parent/invoices.ts', 'what invoices consumes from outside billing'],
    ['invoices/.parent.ts', 'what invoices exposes outside billing'],
  ])('accepts %s (%s)', (rel) => {
    expect(ok(billing, rel)).toBe(true);
  });

  it('parses provider and consumer', () => {
    expect(classifyDmzPath(billing, 'payments/invoices.ts', '.ts')).toEqual({
      file: 'root/billing/dmz/payments/invoices.ts',
      owner: 'root/billing',
      provider: 'payments',
      consumer: 'invoices',
    });
  });

  it.each([
    ['invoices/invoices.ts', 'a bucket consuming itself'],
    ['shipping/invoices.ts', 'a provider that is not a child'],
    ['payments/shipping.ts', 'a consumer that is not a sibling'],
    ['.self/.self.ts', '.self consuming .self'],
    ['.self/.parent.ts', '.parent as consumer under .self'],
    ['.parent/.self.ts', '.self as consumer under .parent'],
    ['.parent/.parent.ts', '.parent consuming .parent'],
    ['payments/invoices.js', 'a wrong extension'],
    ['payments/.ts', 'an empty consumer name'],
    ['invoices.ts', 'a loose file in dmz/'],
    ['payments/deep/invoices.ts', 'a nested folder'],
  ])('rejects %s (%s)', (rel) => {
    const result = classifyDmzPath(billing, rel, '.ts');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain(`root/billing/dmz/${rel}`);
  });

  it('accepts sibling and .self consumers in the root DMZ', () => {
    expect(ok(root, 'log/billing.ts')).toBe(true);
    expect(ok(root, 'log/.self.ts')).toBe(true);
    expect(ok(root, '.self/log.ts')).toBe(true);
  });

  it('rejects .parent in the root DMZ, as provider and as consumer', () => {
    expect(ok(root, '.parent/log.ts')).toBe(false);
    expect(ok(root, 'log/.parent.ts')).toBe(false);
  });

  it('says what an unknown provider or consumer is not, in a readable sentence', () => {
    const consumer = classifyDmzPath(root, 'log/nobody.ts', '.ts');
    expect('error' in consumer && consumer.error).toContain('"nobody" is not a sibling bucket of log, and it is not .self.');
    const provider = classifyDmzPath(billing, 'shipping/invoices.ts', '.ts');
    expect('error' in provider && provider.error).toContain('"shipping" is not a child bucket of root/billing, and it is not .self or .parent.');
  });
});

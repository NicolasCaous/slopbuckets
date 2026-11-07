import { createHash } from 'node:crypto';
import { z } from 'zod';

export const id = (s: string) => createHash('sha1').update(z.string().parse(s)).digest('hex');
export function charge(amount: number): number {
  return amount * 2;
}

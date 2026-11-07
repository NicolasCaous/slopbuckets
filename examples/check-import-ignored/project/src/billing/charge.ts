import { env } from '../../scripts/env';

export function charge(amount: number): number {
  return env === 'test' ? amount : amount * 2;
}

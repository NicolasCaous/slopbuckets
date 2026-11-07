import { pay } from '../payments/index';

export function invoice(): string {
  return pay('invoice');
}

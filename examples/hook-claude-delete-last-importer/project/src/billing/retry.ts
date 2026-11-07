import { charge } from '../payments';

export function retry(amount: number): string {
  return charge(amount);
}

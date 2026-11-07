import { rate } from '../app/index';

export function charge(amount: number): number {
  return amount * rate;
}

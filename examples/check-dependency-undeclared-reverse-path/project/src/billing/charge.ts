import { shopName } from '../app/index';

export function charge(amount: number): number {
  return shopName.length + amount * 2;
}

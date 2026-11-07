// Bills each order with charge from payments.
import { charge } from '../payments';

export function bill(amount: number): string {
  return charge(amount);
}

import { record } from '../ledger/index';

export function pay(what: string): string {
  return record(what);
}

import { invoice } from '../billing/index';

export function pay(what: string): string {
  return what === 'again' ? invoice() : what;
}

import { invoice } from '../billing/index';

export function record(what: string): string {
  return what === 'again' ? invoice() : what;
}

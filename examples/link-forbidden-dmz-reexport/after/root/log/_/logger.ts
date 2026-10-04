import { prefix } from '@root/dmz/web/log';

export function logger(message: string): void {
  console.log(prefix(message));
}

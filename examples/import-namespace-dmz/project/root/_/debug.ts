import * as log from '@root/dmz/log/.self';

export function debug(message: string): void {
  log.logger.info('[debug] ' + message);
}

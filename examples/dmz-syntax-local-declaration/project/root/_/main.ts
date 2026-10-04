import { LOG_PREFIX, logger } from '@root/dmz/log/.self';

export function main(): void {
  logger.info(LOG_PREFIX + ' app started');
}

main();

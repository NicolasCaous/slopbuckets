import { Logger } from '@root/dmz/log/.self';

export function main(): void {
  const logger = Logger.create('app');
  logger.info('app started at level ' + logger.level);
}

main();

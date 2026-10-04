import { logger } from '@root/dmz/log/.self';

export function main(): void {
  logger.info('app started');
  logService.error('through a global');
}

main();

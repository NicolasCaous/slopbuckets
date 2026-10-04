import { logger } from '@root/dmz/log/.self';
import { logger as direct } from 'log-internals';

export function main(): void {
  logger.info('app started');
  direct.error('straight from log/_');
}

main();

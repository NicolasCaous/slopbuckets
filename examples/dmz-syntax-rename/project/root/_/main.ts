import { format, logger } from '@root/dmz/log/.self';

export function main(): void {
  logger.info(format('info', 'app started'));
}

main();

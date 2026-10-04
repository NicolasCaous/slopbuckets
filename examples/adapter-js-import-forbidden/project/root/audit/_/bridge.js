import { logger } from '@root/log/_/logger';

export function audit(message) {
  logger.info('audit: ' + message);
}

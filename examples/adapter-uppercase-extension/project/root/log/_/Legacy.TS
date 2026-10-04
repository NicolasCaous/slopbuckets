import { logger } from './logger';

export function legacy(message: string): void {
  logger.info(message);
}

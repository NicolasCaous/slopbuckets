import { logger, type Logger } from '@root/log/_/logger';

declare global {
  var logService: Logger;
}

globalThis.logService = logger;

export interface Logger {
  info(message: string): void;
  error(message: string): void;
  warn?(message: string): void;
}

export const logger: Logger = {
  info(message) {
    console.log('[info] ' + message);
  },
  error(message) {
    console.error('[error] ' + message);
  },
};

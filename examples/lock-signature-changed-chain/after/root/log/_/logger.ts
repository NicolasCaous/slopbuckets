export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function suffix(context?: Record<string, unknown>): string {
  return context ? ' ' + JSON.stringify(context) : '';
}

export const logger: Logger = {
  info(message, context) {
    console.log('[info] ' + message + suffix(context));
  },
  error(message, context) {
    console.error('[error] ' + message + suffix(context));
  },
};

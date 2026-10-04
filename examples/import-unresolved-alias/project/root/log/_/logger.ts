import { redact } from '@root/log/_/redact';

export const logger = {
  info(message: string): void {
    console.log('[info] ' + redact(message));
  },
  error(message: string): void {
    console.error('[error] ' + redact(message));
  },
};

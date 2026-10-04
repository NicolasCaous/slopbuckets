import { settings } from '@root/dmz/.parent/log';

export const logger = {
  info(message: string): void {
    if (settings.level === 'info') console.log('[info] ' + message);
  },
  error(message: string): void {
    console.error('[error] ' + message);
  },
};

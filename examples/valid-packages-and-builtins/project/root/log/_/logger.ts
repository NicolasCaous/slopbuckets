import { randomUUID } from 'node:crypto';
import { hostname } from 'os';
import pino from 'pino';

const base = pino({ name: 'app' });
const instance = hostname() + '-' + randomUUID();

export const logger = {
  info(message: string): void {
    base.info('[' + instance + '] ' + message);
  },
  error(message: string): void {
    base.error('[' + instance + '] ' + message);
  },
};

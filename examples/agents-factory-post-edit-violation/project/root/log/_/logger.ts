import { formatLine } from './format';

export const logger = {
  info(message: string): void {
    console.log(formatLine('info', message));
  },
  error(message: string): void {
    console.error(formatLine('error', message));
  },
};

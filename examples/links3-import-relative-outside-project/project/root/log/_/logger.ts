import { formatLine } from '../../../../shared/format';

export const logger = {
  info(message: string): void {
    console.log(formatLine('info', message));
  },
};

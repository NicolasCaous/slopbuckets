import chalk from 'chalk';

export const logger = {
  info(message: string): void {
    console.log(chalk.blue('[info] ') + message);
  },
  error(message: string): void {
    console.error(chalk.red('[error] ') + message);
  },
};

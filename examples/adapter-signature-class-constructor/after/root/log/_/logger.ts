export class Logger {
  level = 'info';

  private constructor(readonly name: string) {}

  static create(name: string): Logger {
    return new Logger(name);
  }

  info(message: string): void {
    console.log('[' + this.name + '] ' + message);
  }

  error(message: string): void {
    console.error('[' + this.name + '] ' + message);
  }
}

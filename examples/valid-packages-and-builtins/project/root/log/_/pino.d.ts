// Local typings for the declared "pino" dependency, so the example type-checks without installing it.
declare module 'pino' {
  interface PinoLogger {
    info(message: string): void;
    error(message: string): void;
  }

  export default function pino(options?: { name?: string }): PinoLogger;
}

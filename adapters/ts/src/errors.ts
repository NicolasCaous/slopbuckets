/** Thrown when the project cannot be analyzed for reasons outside the rules, such as a missing `typescript` package. The CLI maps it to exit code 3. */
export class AdapterEnvironmentError extends Error {
  constructor(
    readonly code: 'no-typescript' | 'no-tsconfig' | 'adapter-failed',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterEnvironmentError';
  }
}

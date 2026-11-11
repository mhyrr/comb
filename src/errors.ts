/** An error the user caused and can fix; the CLI prints its message without a stack. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

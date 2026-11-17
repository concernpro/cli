/**
 * How the command ends, for a script that runs it. Anything but 0 printed why
 * on stderr.
 */
export const EXIT = {
  ok: 0,
  /** It did not work, and nothing was sent. */
  failed: 1,
  /** The command was written wrong: an unknown flag, a missing value. */
  usage: 2,
  /** Nobody is signed in on this computer, or the sign-in has ended. */
  signedOut: 3,
  /**
   * Concern's team did not answer in time. The request may or may not have
   * arrived; sending the same plan again is safe.
   */
  unsure: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the person can act on: its message is printed as it is, without a stack. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT.failed) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const signedOut = (message = "Not signed in. Run: concern login") => new CliError(message, EXIT.signedOut);
export const usage = (message: string) => new CliError(`${message}\nSee: concern help`, EXIT.usage);

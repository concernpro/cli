/**
 * The sign-in of this computer, kept fresh: an access token lasts an hour, and
 * is renewed with the refresh token, which is replaced each time it is used.
 *
 * Two commands at once, in two terminals, may both find the token run out.
 * Concern trades a refresh token once, so one of them is refused. The refused
 * one looks at the file again: the other has written the tokens it was given,
 * and those are taken.
 */
import { CliError, signedOut } from "./errors.ts";
import { OAuthError, refresh, type Fetch } from "./oauth.ts";
import type { Credentials, Store } from "./store.ts";

/** Renewed this long before it runs out, so that it does not run out on the way. */
const MARGIN_MS = 60 * 1000;
/** How long a refused renewal waits for the other command's tokens to reach the file. */
const REREAD_DELAYS_MS = [100, 300, 800];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Session {
  readonly store: Store;
  readonly fetch: Fetch;
  readonly now: () => number;

  constructor(store: Store, fetcher: Fetch, now: () => number = Date.now) {
    this.store = store;
    this.fetch = fetcher;
    this.now = now;
  }

  credentials(): Credentials {
    const credentials = this.store.credentials();
    if (!credentials) throw signedOut();
    return credentials;
  }

  /** An access token that has time left on it. */
  async accessToken(): Promise<string> {
    const credentials = this.credentials();
    if (credentials.expiresAt - MARGIN_MS > this.now()) return credentials.accessToken;
    return (await this.renew(credentials)).accessToken;
  }

  /** A new access token, after the server refused the one it was shown. */
  async renewed(refused: string): Promise<string> {
    const credentials = this.credentials();
    // Another command renewed it already.
    if (credentials.accessToken !== refused && credentials.expiresAt - MARGIN_MS > this.now()) return credentials.accessToken;
    return (await this.renew(credentials)).accessToken;
  }

  private async renew(credentials: Credentials): Promise<Credentials> {
    try {
      const tokens = await refresh(this.fetch, credentials.tokenEndpoint, credentials.clientId, credentials.refreshToken);
      const renewed: Credentials = { ...credentials, ...tokens, expiresAt: this.now() + tokens.expiresIn * 1000 };
      // Written before anything else is done: the refresh token that was used is spent.
      this.store.saveCredentials(renewed);
      return renewed;
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.code === "invalid_grant") {
        for (const delay of REREAD_DELAYS_MS) {
          await sleep(delay);
          const current = this.store.credentials();
          if (current && current.refreshToken !== credentials.refreshToken) return current;
        }
      }
      if (error.code === "invalid_grant" || error.code === "invalid_client") {
        // Sixty days unused, disconnected on concern.pro, or the person left the team: it is over, here too.
        this.store.saveCredentials(null);
        throw signedOut("Your sign-in has ended. Run: concern login");
      }
      throw new CliError(`Concern did not renew the sign-in (${error.code}). Try again in a moment.`);
    }
  }
}

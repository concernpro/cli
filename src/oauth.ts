/**
 * Signing in: OAuth 2.1 with PKCE, as concern.pro offers it to an app on the
 * person's own computer, the way Claude Code connects.
 *
 * 1. Discovery. The MCP server names its authorization server
 *    (RFC 9728), which says where each step is (RFC 8414).
 * 2. Registration (RFC 7591). The CLI is a public client: it has no secret,
 *    and returns to an address on this computer, whose port the server does
 *    not compare. It registers anew at each sign-in. A registration nobody
 *    approved is forgotten by the server within a week, and one whose
 *    approvals have all ended some weeks after, so an id kept from long ago
 *    could lead to a page that only says it is not known.
 * 3. The browser. The person approves on concern.pro, which names the team
 *    and the workspace the CLI is let into, and sends the browser back to a
 *    one-off server on 127.0.0.1 with a code.
 * 4. The code is traded for an access token, good for an hour, and a refresh
 *    token, good for sixty days and replaced each time it is used.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CliError, signedOut } from "./errors.ts";

export const CLIENT_NAME = "Concern CLI";
/** Registered once without a port: the port is the one the listener gets when it starts. */
const REGISTERED_REDIRECT = "http://127.0.0.1/callback";
const CALLBACK_PATH = "/callback";

export type Fetch = typeof fetch;

export type ServerMetadata = {
  /** The MCP server, exactly as it names itself: what a token is asked for. */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
};

export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };

/** A refusal from the authorization server, by OAuth's name for it. */
export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.code = code;
  }
}

/**
 * The address of a Concern site, as an origin. https only, but for a copy of
 * the site on this computer: the tokens travel to it.
 */
export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`Not an address: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new CliError(`Concern is reached over https: ${raw}`);
  return url.origin;
}

function sameOrigin(address: string, origin: string): boolean {
  try {
    return new URL(address).origin === origin;
  } catch {
    return false;
  }
}

async function getJson(fetcher: Fetch, url: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new CliError(`Could not reach ${new URL(url).host}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new CliError(`${url} answered ${response.status}.`);
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) throw new CliError(`${url} did not answer with JSON.`);
  return body as Record<string, unknown>;
}

/**
 * Where to sign in, read from the site itself. Every address it names must be
 * on the same site: a document that pointed elsewhere would send the person's
 * approval, and later their tokens, to someone else.
 */
export async function discover(fetcher: Fetch, origin: string): Promise<ServerMetadata> {
  const resourceDocument = await getJson(fetcher, `${origin}/.well-known/oauth-protected-resource/mcp`);
  const resource = resourceDocument.resource;
  const issuer = Array.isArray(resourceDocument.authorization_servers) ? resourceDocument.authorization_servers[0] : undefined;
  if (typeof resource !== "string" || !sameOrigin(resource, origin)) throw new CliError(`${origin} names an MCP server that is not on it.`);
  if (typeof issuer !== "string" || !sameOrigin(issuer, origin)) throw new CliError(`${origin} names an authorization server that is not on it.`);

  const server = await getJson(fetcher, `${new URL(issuer).origin}/.well-known/oauth-authorization-server`);
  const endpoint = (name: string): string => {
    const value = server[name];
    if (typeof value !== "string" || !sameOrigin(value, origin)) throw new CliError(`${origin} does not offer sign-in for apps on a computer (${name}).`);
    return value;
  };
  const methods = server.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) throw new CliError(`${origin} does not offer PKCE with S256.`);
  return {
    resource,
    authorizationEndpoint: endpoint("authorization_endpoint"),
    tokenEndpoint: endpoint("token_endpoint"),
    registrationEndpoint: endpoint("registration_endpoint"),
  };
}

export async function register(fetcher: Fetch, metadata: ServerMetadata, name = CLIENT_NAME): Promise<string> {
  const response = await fetcher(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REGISTERED_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 429) throw new CliError("Too many sign-ins from this network just now. Wait a minute and run concern login again.");
  if (!response.ok || typeof body.client_id !== "string") {
    throw new CliError(`Concern refused to register the CLI: ${String(body.error_description ?? body.error ?? response.status)}`);
  }
  return body.client_id;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** PKCE (RFC 7636): a secret kept here, and its SHA-256, which goes out first. */
export function pkce(verifier = base64Url(randomBytes(32))): { verifier: string; challenge: string } {
  return { verifier, challenge: base64Url(createHash("sha256").update(verifier).digest()) };
}

export function authorizationUrl(
  metadata: ServerMetadata,
  request: { clientId: string; redirectUri: string; challenge: string; state: string },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("code_challenge", request.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", request.state);
  url.searchParams.set("resource", metadata.resource);
  return url.toString();
}

const PAGE = (title: string, line: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;color:#111;background:#fff">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${line}</p></body>`;

export type Listener = {
  redirectUri: string;
  /** The code the browser brought back, or why there is none. */
  code: Promise<string>;
  close: () => void;
};

/**
 * A server on 127.0.0.1 that waits for the browser to come back from
 * concern.pro with a code. It takes only an answer that carries the state
 * this sign-in sent, and stops once it has one, or at the time limit.
 */
export async function listen(state: string, timeoutMs: number): Promise<Listener> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  // Nobody may be waiting on it yet when it fails: the failure is still read once someone does.
  code.catch(() => {});

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, title: string, line: string) => {
      // The browser is not to keep the connection: once the answer is in, the listener is done.
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
      response.end(PAGE(title, line));
    };
    if (url.pathname !== CALLBACK_PATH) return reply(404, "Not found", "This address is the Concern CLI's, for signing in.");
    // An answer to another sign-in, or a page someone else opened: not ours to take.
    if (url.searchParams.get("state") !== state) return reply(400, "Not this sign-in", "Go back to the terminal and run concern login again.");
    const error = url.searchParams.get("error");
    const given = url.searchParams.get("code");
    if (error) {
      reply(200, "Not signed in", "Concern was not let in. You can close this tab.");
      settle.reject(error === "access_denied" ? new CliError("You did not allow the CLI. Nothing was signed in.") : new OAuthError(error));
    } else if (given) {
      reply(200, "Signed in", "The Concern CLI is signed in. You can close this tab and go back to the terminal.");
      settle.resolve(given);
    } else {
      return reply(400, "No code", "Go back to the terminal and run concern login again.");
    }
    close();
  });

  const timer = setTimeout(() => {
    settle.reject(new CliError("Signing in took too long. Run concern login again."));
    close();
  }, timeoutMs);
  function close() {
    clearTimeout(timer);
    // Stops taking connections; the answer being written still goes out.
    server.close();
    server.closeIdleConnections();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, code, close };
}

async function tokenRequest(fetcher: Fetch, endpoint: string, form: Record<string, string>): Promise<Tokens> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new CliError(`Could not reach ${new URL(endpoint).host}: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 429) throw new CliError("Concern is answering too many sign-ins from this network. Wait a minute and try again.");
  if (!response.ok) throw new OAuthError(typeof body.error === "string" ? body.error : `status ${response.status}`);
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = body;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresIn !== "number") throw new CliError("Concern answered the sign-in without tokens.");
  return { accessToken, refreshToken, expiresIn };
}

export function exchangeCode(
  fetcher: Fetch,
  metadata: ServerMetadata,
  request: { clientId: string; code: string; redirectUri: string; verifier: string },
): Promise<Tokens> {
  return tokenRequest(fetcher, metadata.tokenEndpoint, {
    grant_type: "authorization_code",
    client_id: request.clientId,
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.verifier,
    resource: metadata.resource,
  });
}

export function refresh(fetcher: Fetch, tokenEndpoint: string, clientId: string, refreshToken: string): Promise<Tokens> {
  return tokenRequest(fetcher, tokenEndpoint, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
}

export type SignInOptions = {
  fetch: Fetch;
  origin: string;
  /** Opens the address in the person's browser. False where it could not, and the address is printed for them to open. */
  openBrowser: (url: string) => Promise<boolean>;
  say: (line: string) => void;
  timeoutMs?: number;
};

/** The whole sign-in, from discovery to tokens. */
export async function signIn(options: SignInOptions): Promise<Tokens & { clientId: string; metadata: ServerMetadata }> {
  const metadata = await discover(options.fetch, options.origin);
  const clientId = await register(options.fetch, metadata);
  const state = base64Url(randomBytes(16));
  const { verifier, challenge } = pkce();
  // Ten minutes: someone new to Concern signs in with Google and answers a few questions on the way.
  const listener = await listen(state, options.timeoutMs ?? 10 * 60 * 1000);
  try {
    const url = authorizationUrl(metadata, { clientId, redirectUri: listener.redirectUri, challenge, state });
    const opened = await options.openBrowser(url).catch(() => false);
    options.say(opened ? `Your browser is open on ${new URL(url).host}. Approve the CLI there.` : "Open this address in your browser and approve the CLI:");
    options.say(url);
    const code = await listener.code;
    try {
      const tokens = await exchangeCode(options.fetch, metadata, { clientId, code, redirectUri: listener.redirectUri, verifier });
      return { ...tokens, clientId, metadata };
    } catch (error) {
      if (error instanceof OAuthError) throw signedOut(`Concern did not take the approval (${error.code}). Run concern login again.`);
      throw error;
    }
  } finally {
    listener.close();
  }
}

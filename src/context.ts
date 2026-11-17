import type { Args } from "./args.ts";
import { flag, on } from "./args.ts";
import { CliError } from "./errors.ts";
import type { Io } from "./io.ts";
import { McpClient } from "./mcp.ts";
import { normalizeOrigin } from "./oauth.ts";
import { Session } from "./session.ts";
import { Store, configDir } from "./store.ts";

export const VERSION = "0.1.0";
export const DEFAULT_ORIGIN = "https://concern.pro";

/** What a command is run with. */
export type Context = {
  io: Io;
  args: Args;
  origin: string;
  store: Store;
  session: Session;
  /** Answer as JSON on stdout, and ask nothing. */
  json: boolean;
  /** A person can be asked: a terminal, and not --json. */
  interactive: boolean;
  mcp: () => McpClient;
};

export function makeContext(io: Io, args: Args): Context {
  const origin = normalizeOrigin(flag(args, "url") ?? io.env.CONCERN_URL ?? DEFAULT_ORIGIN);
  const store = new Store(configDir(io.env), origin);
  const session = new Session(store, io.fetch, io.now);
  const json = on(args, "json");
  let client: McpClient | null = null;
  return {
    io,
    args,
    origin,
    store,
    session,
    json,
    interactive: io.interactive && !json,
    mcp: () => {
      // The server the token was given for, as the site named it at sign-in.
      client ??= new McpClient({ url: session.credentials().resource, session, fetch: io.fetch, clientVersion: VERSION });
      return client;
    },
  };
}

/** Prints a value as JSON on stdout: what --json answers. */
export function printJson(context: Context, value: unknown): void {
  context.io.out(JSON.stringify(value, null, 2));
}

/** The structured data of a tool's answer, which every command here expects. */
export function dataOf(outcome: { text: string; data: Record<string, unknown> | null }, tool: string): Record<string, unknown> {
  if (!outcome.data) throw new CliError(`Concern answered ${tool} without its data. ${outcome.text}`.trim());
  return outcome.data;
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** A catalog price in US dollars, as the site writes it. */
export function formatPrice(usd: number): string {
  return money.format(usd);
}

/** An estimate as the list of requests gives it. */
export function formatEstimate(estimate: unknown): string {
  const value = (typeof estimate === "object" && estimate !== null ? estimate : {}) as { amount?: unknown; unit?: unknown };
  if (typeof value.amount !== "number") return "quoted individually";
  return value.unit === "month" ? `${formatPrice(value.amount)} a month` : `from ${formatPrice(value.amount)}`;
}

/** Text from the server, on one line and no longer than a terminal line. */
export function oneLine(text: string, length = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat;
}

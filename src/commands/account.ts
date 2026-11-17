/** Signing in and out, and who is signed in where. */
import { dataOf, printJson, type Context } from "../context.ts";
import { EXIT, type ExitCode } from "../errors.ts";
import { signIn } from "../oauth.ts";
import type { Account } from "../store.ts";
import { on } from "../args.ts";

/** Asks the workspace who is signed in, prints it, and keeps the names with the sign-in. */
async function describeWorkspace(context: Context): Promise<Record<string, unknown>> {
  const data = dataOf(await context.mcp().callTool("get_workspace"), "get_workspace");
  const account: Account = { email: String(data.email ?? ""), team: String(data.team ?? ""), workspace: String(data.workspace ?? "") };
  const credentials = context.store.credentials();
  if (credentials) context.store.saveCredentials({ ...credentials, account });
  return data;
}

function printWorkspace(context: Context, data: Record<string, unknown>): void {
  const { out } = context.io;
  out(`Signed in as ${data.email}`);
  out(`Team:       ${data.team}`);
  out(`Workspace:  ${data.workspace}`);
  const connections = Array.isArray(data.connections) ? (data.connections as { name?: string; connected?: boolean }[]) : [];
  const connected = connections.filter((connection) => connection.connected).map((connection) => connection.name);
  out(`Connected:  ${connected.length > 0 ? connected.join(", ") : "no task manager yet"}`);
  const engineers = Array.isArray(data.engineers) ? (data.engineers as { name?: string }[]) : [];
  // An empty list is not "nobody was deployed": Concern's team lists them by hand, and has not yet.
  out(`Engineers:  ${engineers.length > 0 ? engineers.map((engineer) => engineer.name).join(", ") : "not listed here yet; Concern's team answers each request by email"}`);
  const links = (data.links ?? {}) as Record<string, string>;
  if (links.dashboard) out(`Dashboard:  ${links.dashboard}`);
}

export async function login(context: Context): Promise<ExitCode> {
  const { io } = context;
  const signed = await signIn({
    fetch: io.fetch,
    origin: context.origin,
    openBrowser: on(context.args, "no-browser") ? async () => false : io.openBrowser,
    say: io.err,
  });
  context.store.saveCredentials({
    clientId: signed.clientId,
    tokenEndpoint: signed.metadata.tokenEndpoint,
    resource: signed.metadata.resource,
    accessToken: signed.accessToken,
    refreshToken: signed.refreshToken,
    expiresAt: io.now() + signed.expiresIn * 1000,
  });
  const data = await describeWorkspace(context);
  if (context.json) printJson(context, data);
  else {
    printWorkspace(context, data);
    io.out("");
    io.out("Hire someone with: concern hire");
  }
  return EXIT.ok;
}

export async function logout(context: Context): Promise<ExitCode> {
  const credentials = context.store.credentials();
  context.store.saveCredentials(null);
  if (!credentials) {
    context.io.out("Nobody is signed in on this computer.");
    return EXIT.ok;
  }
  // concern.pro has no address an app can end its own approval at: the person ends it there.
  context.io.out("Signed out on this computer.");
  context.io.out(`The approval stays listed in ${context.origin}/account/integrations until it has gone unused for sixty days. Disconnect there ends it at once.`);
  return EXIT.ok;
}

export async function whoami(context: Context): Promise<ExitCode> {
  const data = await describeWorkspace(context);
  if (context.json) printJson(context, data);
  else printWorkspace(context, data);
  return EXIT.ok;
}

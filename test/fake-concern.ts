/**
 * A stand-in for concern.pro, as much of it as the CLI talks to: the two
 * discovery documents, registration, approval, tokens and the MCP server with
 * its tools. It follows the rules the real site states in its README and
 * code: a port on 127.0.0.1 is not compared, PKCE is S256 only, a refresh
 * token is traded once, a plan sent twice is one request.
 *
 * The person's approval happens without a page: /api/oauth/authorize answers
 * with the redirect the "Allow" button would, or "deny" when told to.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const token = () => randomBytes(24).toString("base64url");
const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

const WORK_TYPES: Record<string, { product: string; label: string; from: number | null }> = {
  feature: { product: "engineer", label: "Feature", from: 300 },
  landing: { product: "engineer", label: "Landing page", from: 500 },
  integration: { product: "engineer", label: "Integration", from: 600 },
  redesign: { product: "engineer", label: "Redesign", from: 2400 },
  "custom-build": { product: "engineer", label: "Something else", from: null },
  review: { product: "verifier", label: "Code review", from: 150 },
  tests: { product: "verifier", label: "Test suite", from: 250 },
  release: { product: "verifier", label: "Release sign-off", from: 400 },
  "custom-verify": { product: "verifier", label: "Something else", from: null },
};
const SEAT_PRICE: Record<string, number> = { engineer: 2500, verifier: 1800 };

export type SentRequest = { reference: string; args: Record<string, unknown> };

export class FakeConcern {
  origin = "";
  private server: Server | null = null;
  readonly clients = new Map<string, { redirectUris: string[] }>();
  private codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string }>();
  private access = new Map<string, number>();
  private refresh = new Map<string, string>();
  private plans = new Set<string>();
  readonly sent: SentRequest[] = [];
  /** How long an access token lasts, in seconds. */
  accessSeconds = 3600;
  /** The person presses "Deny" instead of "Allow". */
  deny = false;
  /** The next send times out on the team's end: it may or may not have arrived. */
  timeOutNextSend = false;
  /** Every MCP method called, in order. */
  readonly calls: string[] = [];
  readonly tokenGrants: string[] = [];

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      this.handle(request).then(
        ({ status, body, headers }) => {
          response.writeHead(status, { "content-type": "application/json", ...headers });
          response.end(body === undefined ? "" : JSON.stringify(body));
        },
        (error) => {
          response.writeHead(500);
          response.end(String(error));
        },
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    this.server?.closeAllConnections();
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }

  /** Every approval ends, as "Disconnect" on /account/integrations does. */
  disconnect(): void {
    this.access.clear();
    this.refresh.clear();
  }

  /** Runs out every access token, as an hour does. */
  expireAccess(): void {
    this.access.clear();
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
    const url = new URL(request.url ?? "/", this.origin);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return { status: 200, body: { resource: `${this.origin}/mcp`, authorization_servers: [this.origin], bearer_methods_supported: ["header"] } };
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return {
        status: 200,
        body: {
          issuer: this.origin,
          authorization_endpoint: `${this.origin}/api/oauth/authorize`,
          token_endpoint: `${this.origin}/api/oauth/token`,
          registration_endpoint: `${this.origin}/api/oauth/register`,
          code_challenge_methods_supported: ["S256"],
        },
      };
    }
    if (url.pathname === "/api/oauth/register" && request.method === "POST") return this.register(JSON.parse(raw));
    if (url.pathname === "/api/oauth/authorize") return this.authorize(url.searchParams);
    if (url.pathname === "/api/oauth/token" && request.method === "POST") return this.token(new URLSearchParams(raw));
    if (url.pathname === "/mcp" && request.method === "POST") return this.mcp(request.headers.authorization ?? "", JSON.parse(raw));
    return { status: 404, body: { error: "not_found" } };
  }

  private register(body: { redirect_uris?: string[]; token_endpoint_auth_method?: string }) {
    const uris = body.redirect_uris ?? [];
    const loopback = (uri: string) => {
      const parsed = new URL(uri);
      return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    };
    if (uris.length === 0 || !uris.every(loopback)) return { status: 400, body: { error: "invalid_redirect_uri" } };
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") return { status: 400, body: { error: "invalid_client_metadata" } };
    const id = token().slice(0, 32);
    this.clients.set(id, { redirectUris: uris });
    return { status: 201, body: { client_id: id, redirect_uris: uris, token_endpoint_auth_method: "none" } };
  }

  private authorize(params: URLSearchParams) {
    const client = this.clients.get(params.get("client_id") ?? "");
    const redirectUri = params.get("redirect_uri") ?? "";
    // Port not compared on this computer: host, path and query are.
    const asked = new URL(redirectUri);
    const registered = client?.redirectUris.some((uri) => {
      const known = new URL(uri);
      return known.hostname === asked.hostname && known.pathname === asked.pathname && known.search === asked.search;
    });
    if (!client || !registered) return { status: 400, body: { error: "invalid_client" } };
    const back = new URL(redirectUri);
    const state = params.get("state") ?? "";
    if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "")) {
      back.searchParams.set("error", "invalid_request");
    } else if (params.get("resource") !== `${this.origin}/mcp`) {
      back.searchParams.set("error", "invalid_target");
    } else if (this.deny) {
      back.searchParams.set("error", "access_denied");
    } else {
      const code = token();
      this.codes.set(code, { clientId: params.get("client_id")!, redirectUri, challenge: params.get("code_challenge")!, resource: params.get("resource")! });
      back.searchParams.set("code", code);
    }
    if (state) back.searchParams.set("state", state);
    return { status: 303, headers: { location: back.toString() } };
  }

  private issue(clientId: string) {
    const accessToken = token();
    const refreshToken = token();
    this.access.set(accessToken, Date.now() + this.accessSeconds * 1000);
    this.refresh.set(refreshToken, clientId);
    return { status: 200, body: { access_token: accessToken, token_type: "Bearer", expires_in: this.accessSeconds, refresh_token: refreshToken } };
  }

  private token(form: URLSearchParams) {
    const clientId = form.get("client_id") ?? "";
    if (!this.clients.has(clientId)) return { status: 401, body: { error: "invalid_client" } };
    const grant = form.get("grant_type");
    this.tokenGrants.push(grant ?? "");
    if (grant === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      // A code is traded once.
      this.codes.delete(form.get("code") ?? "");
      if (!code || code.clientId !== clientId || code.redirectUri !== form.get("redirect_uri") || sha256(form.get("code_verifier") ?? "") !== code.challenge) {
        return { status: 400, body: { error: "invalid_grant" } };
      }
      if ((form.get("resource") ?? "") !== code.resource) return { status: 400, body: { error: "invalid_grant" } };
      return this.issue(clientId);
    }
    if (grant === "refresh_token") {
      const owner = this.refresh.get(form.get("refresh_token") ?? "");
      if (owner !== clientId) return { status: 400, body: { error: "invalid_grant" } };
      // Replaced each time it is used.
      this.refresh.delete(form.get("refresh_token") ?? "");
      return this.issue(clientId);
    }
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }

  private mcp(authorization: string, message: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }) {
    const bearer = /^Bearer (.+)$/.exec(authorization)?.[1] ?? "";
    const expires = this.access.get(bearer);
    if (!expires || expires < Date.now()) {
      return { status: 401, body: { error: "invalid_token" }, headers: { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"` } };
    }
    this.calls.push(message.method === "tools/call" ? `tools/call ${message.params?.name}` : message.method);
    if (!("id" in message)) return { status: 202 };
    const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: message.id, result } });
    if (message.method === "initialize") return ok({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "concern", version: "test" } });
    if (message.method !== "tools/call") return { status: 200, body: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No such method" } } };
    return ok(this.tool(message.params?.name ?? "", message.params?.arguments ?? {}));
  }

  private tool(name: string, args: Record<string, unknown>) {
    const text = (value: string) => [{ type: "text", text: value }];
    const refusal = (value: string, data?: Record<string, unknown>) => ({ content: text(value), isError: true, ...(data && { structuredContent: data }) });
    if (name === "get_workspace") {
      return {
        content: text("Workspace Main of the team Acme"),
        structuredContent: {
          view: "workspace",
          team: "Acme",
          workspace: "Main",
          email: "lead@acme.test",
          connections: [{ id: "linear", name: "Linear", connected: true, workspace: "" }],
          engineers: [{ name: "Ada" }],
          links: { dashboard: `${this.origin}/account` },
        },
      };
    }
    if (name === "get_pricing") return { content: text('- engineer, one task, work_type "feature": Feature. From $300.') };
    if (name === "list_requests") {
      return {
        content: text("…"),
        structuredContent: {
          view: "requests",
          requests: [...this.sent].reverse().map((request) => ({
            id: request.reference,
            date: new Date().toISOString(),
            by: "lead@acme.test",
            work: String(request.args.product),
            task: String(request.args.task),
            estimate: { amount: 300, unit: "task" },
            done: null,
          })),
          more: false,
          links: { usage: `${this.origin}/account/usage?days=90` },
        },
      };
    }
    if (name === "plan_deployment" || name === "request_deployment") {
      const { product, mode, work_type: workType, seats, speed = "standard", task, plan } = args as Record<string, string | number | undefined>;
      if (product !== "engineer" && product !== "verifier") return refusal('product must be "engineer" or "verifier".');
      if (mode !== "task" && mode !== "subscription") return refusal('mode must be "task" or "subscription".');
      if (typeof task !== "string" || task.trim().length < 10) return refusal("task must describe the work in a sentence or two.");
      const type = WORK_TYPES[String(workType)];
      if (mode === "task" && (!type || type.product !== product)) return refusal(`work_type must be one for ${product} work.`);
      const multiplier = speed === "priority" ? 1.5 : 1;
      const amount = mode === "subscription" ? SEAT_PRICE[product]! * Number(seats ?? 1) * multiplier : type!.from === null ? null : type!.from * multiplier;
      const estimate = { amount, unit: mode === "subscription" ? "month" : "task", text: amount === null ? "quoted individually" : `from $${amount}` };
      const work = mode === "subscription" ? `${seats} ${product}s, monthly subscription` : `${product === "engineer" ? "Engineer" : "Verifier"}, ${type!.label}`;
      const view = (planId: string, sent: string | false) => ({ view: "deployment", input: { ...args, plan: planId }, work, speed: speed === "priority" ? "Priority" : "Standard", starts: "Starts the next business day", estimate, sent });

      if (name === "plan_deployment") {
        const id = token().slice(0, 32);
        this.plans.add(id);
        return { content: text(`Plan ${id}`), structuredContent: view(id, false) };
      }
      if (typeof plan !== "string" || !this.plans.has(plan)) return refusal("This plan id is not one that plan_deployment returned for this person.");
      const reference = `CR-${sha256(plan).slice(0, 8)}`;
      const before = this.sent.find((request) => request.reference === reference);
      if (before) return { content: text(`Already sent under ${reference}`), structuredContent: { ...view(plan, reference), repeated: true } };
      if (this.timeOutNextSend) {
        this.timeOutNextSend = false;
        return refusal("Concern's team did not answer in time, so the request may or may not have arrived. Sending it again with the same plan is safe.", { view: "failure", line: "…", unsure: true });
      }
      this.sent.push({ reference, args });
      return { content: text(`Sent. Reference ${reference}`), structuredContent: view(plan, reference) };
    }
    return refusal(`No tool ${name}`);
  }
}

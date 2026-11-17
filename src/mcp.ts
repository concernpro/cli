/**
 * A client of concern.pro's MCP server: Streamable HTTP, one JSON-RPC message
 * per POST. The server keeps no session, so the CLI says hello once per run
 * and then calls tools, each with the access token.
 *
 * A token the server refuses is renewed once and the call made again. A tool
 * that did not do what it was asked answers as a result marked `isError`, with
 * words for whoever called it: that is an outcome, not a failure of the call.
 */
import { CliError, signedOut } from "./errors.ts";
import type { Fetch } from "./oauth.ts";
import type { Session } from "./session.ts";

export const PROTOCOL_VERSION = "2025-11-25";

export type ToolOutcome = {
  text: string;
  data: Record<string, unknown> | null;
  isError: boolean;
};

type RpcResponse = { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string } };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The answer to the message with this id, from a JSON body or from an event stream. */
export function readAnswer(contentType: string, body: string, id: number): RpcResponse | null {
  const messages: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    // Events are separated by an empty line; the data of one may run over several lines.
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) messages.push(JSON.parse(data));
    }
  } else {
    const parsed: unknown = JSON.parse(body);
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return (messages.find((message) => record(message)?.id === id) as RpcResponse | undefined) ?? null;
}

export class McpClient {
  readonly url: string;
  private readonly session: Session;
  private readonly fetch: Fetch;
  private readonly version: string;
  private nextId = 1;
  private negotiated: string | null = null;

  constructor(options: { url: string; session: Session; fetch: Fetch; clientVersion: string }) {
    this.url = options.url;
    this.session = options.session;
    this.fetch = options.fetch;
    this.version = options.clientVersion;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    await this.initialize();
    const result = record(await this.request("tools/call", { name, arguments: args }));
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((item) => record(item))
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item!.text as string)
      .join("\n");
    return { text, data: record(result?.structuredContent), isError: result?.isError === true };
  }

  private async initialize(): Promise<void> {
    if (this.negotiated) return;
    const result = record(
      await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "concern-cli", title: "Concern CLI", version: this.version } }),
    );
    this.negotiated = typeof result?.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, null);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const answer = await this.post({ jsonrpc: "2.0", id, method, params }, id);
    if (!answer) throw new CliError(`Concern did not answer ${method}.`);
    if (answer.error) throw new CliError(`Concern refused ${method}: ${answer.error.message}`);
    return answer.result;
  }

  private async post(message: Record<string, unknown>, id: number | null): Promise<RpcResponse | null> {
    let token = await this.session.accessToken();
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(this.negotiated && { "mcp-protocol-version": this.negotiated }),
          },
          body: JSON.stringify(message),
        });
      } catch (error) {
        throw new CliError(`Could not reach ${new URL(this.url).host}: ${(error as Error).message}`);
      }
      if (response.status === 401) {
        if (attempt > 0) throw signedOut("Concern no longer takes this sign-in. Run: concern login");
        token = await this.session.renewed(token);
        continue;
      }
      if (response.status === 429) {
        const wait = Number(response.headers.get("retry-after")) || 60;
        throw new CliError(`Concern is taking no more calls from you for now. Try again in ${wait} seconds.`);
      }
      const body = await response.text();
      // A notification is taken and not answered.
      if (id === null) return null;
      if (!response.ok) throw new CliError(`Concern answered ${response.status}.`);
      try {
        return readAnswer(response.headers.get("content-type") ?? "", body, id);
      } catch {
        throw new CliError("Concern answered with something that is not JSON-RPC.");
      }
    }
  }
}

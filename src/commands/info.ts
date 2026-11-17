/** What can be hired, and what the workspace has asked for. */
import { dataOf, formatEstimate, oneLine, printJson, type Context } from "../context.ts";
import { EXIT, type ExitCode } from "../errors.ts";

export async function pricing(context: Context): Promise<ExitCode> {
  const outcome = await context.mcp().callTool("get_pricing");
  if (context.json) printJson(context, { text: outcome.text });
  else {
    context.io.out(outcome.text);
    context.io.out("");
    context.io.out("Prices are in US dollars. Hire with: concern hire");
  }
  return EXIT.ok;
}

type Listed = { id?: string; date?: string; by?: string; work?: string; task?: string; estimate?: unknown; done?: string | null };

export async function requests(context: Context): Promise<ExitCode> {
  const data = dataOf(await context.mcp().callTool("list_requests"), "list_requests");
  const listed = (Array.isArray(data.requests) ? data.requests : []) as Listed[];
  if (context.json) {
    printJson(context, data);
    return EXIT.ok;
  }
  const { out } = context.io;
  if (listed.length === 0) {
    out("No requests have been sent from this workspace yet. Hire with: concern hire");
    return EXIT.ok;
  }
  for (const request of listed) {
    const status = request.done ? `done ${request.done.slice(0, 10)}` : "open";
    out(`${request.id}  ${String(request.date ?? "").slice(0, 10)}  ${request.work} · ${formatEstimate(request.estimate)} · ${status}`);
    out(`    ${request.by}: ${oneLine(request.task ?? "")}`);
  }
  const links = (data.links ?? {}) as { usage?: string };
  if (data.more === true) out(`\nOlder requests: ${links.usage ?? `${context.origin}/account/usage`}`);
  return EXIT.ok;
}

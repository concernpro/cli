/**
 * `concern`: hire Concern's engineers and verifiers from a terminal.
 *
 * Every command is a call to concern.pro's MCP server, as the person who
 * signed in, in the workspace they approved the CLI for. The CLI holds no
 * prices and no rules of its own that the server does not check again.
 */
import { on, parseArgs } from "./args.ts";
import { login, logout, whoami } from "./commands/account.ts";
import { hire, send } from "./commands/hire.ts";
import { pricing, requests } from "./commands/info.ts";
import { VERSION, makeContext, type Context } from "./context.ts";
import { CliError, EXIT, usage, type ExitCode } from "./errors.ts";
import type { Io } from "./io.ts";

export const HELP = `concern ${VERSION}: hire Concern's engineers and verifiers from your terminal.

Usage:
  concern login              Sign in in your browser and let the CLI into a workspace
  concern hire [task]        Plan a hire, see its price, and send it to Concern's team
  concern send [plan]        Send a plan made before; without one, list plans not sent
  concern requests           What your workspace has asked for, newest first
  concern pricing            What can be hired and what it costs
  concern whoami             Who is signed in, the team and the workspace
  concern logout             Forget the sign-in on this computer

Hiring without questions, for scripts:
  concern hire --engineer --type feature --task "Add a signup form to app.example.com" --yes
  concern hire --verifier --type review --task-file brief.md --priority --yes
  concern hire --engineer --seats 2 --task "Two engineers for our checkout, from Monday" --plan-only

Options of hire:
  --engineer, --verifier     Who does it (or --product engineer|verifier)
  --type <kind>              One task of this kind: feature, landing, integration, redesign,
                             custom-build; review, tests, release, custom-verify
  --subscription, --seats <n>
                             Standing capacity, per seat per month, 1 to 20 seats
  --standard, --priority     How soon (or --speed standard|priority). Standard by default
  --task <text>, -t <text>   The work, as the team should read it
  --task-file <path>         The work from a file, or from stdin with -
  --plan-only                Price it and keep the plan; send later with concern send
  --yes, -y                  Send without asking

Everywhere:
  --json                     Answer as JSON on stdout, and ask nothing
  --url <address>            Another Concern site than https://concern.pro (or CONCERN_URL)
  --no-browser               Print the sign-in address instead of opening it
  --help, -h; --version, -v

Exit codes: 0 done, 1 failed, 2 usage, 3 not signed in, 4 sent but not confirmed (sending the same plan again is safe).
`;

const COMMANDS: Record<string, (context: Context) => Promise<ExitCode>> = { login, logout, whoami, hire, send, requests, pricing };

export async function main(argv: string[], io: Io): Promise<ExitCode> {
  try {
    const args = parseArgs(argv);
    if (on(args, "version")) {
      io.out(VERSION);
      return EXIT.ok;
    }
    if (on(args, "help") || args.command === null || args.command === "help") {
      io.out(HELP);
      return EXIT.ok;
    }
    const command = COMMANDS[args.command];
    if (!command) throw usage(`Unknown command: ${args.command}`);
    return await command(makeContext(io, args));
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return error.exitCode;
    }
    io.err(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  }
}

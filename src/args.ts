import { usage } from "./errors.ts";

/** Flags that are on or off. */
const SWITCHES = new Set(["help", "version", "json", "yes", "engineer", "verifier", "subscription", "standard", "priority", "plan-only", "no-browser"]);

/** Flags that take a value, as `--seats 2` or `--seats=2`. */
const VALUES = new Set(["url", "product", "mode", "type", "seats", "speed", "task", "task-file"]);

const SHORT: Record<string, string> = { h: "help", v: "version", y: "yes", t: "task" };

export type Args = {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | true>;
};

/** What an option looks like: --a-word, with its value after = or not, or a dash and one letter. */
const LONG = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/;
const SHORT_FLAG = /^-([A-Za-z])$/;

/**
 * Reads the command line. Knows no command: each reads the flags it needs,
 * and an unknown flag is refused here. Anything that does not look like an
 * option is an argument, even where it starts with a dash: a plan id is
 * random, and one in sixty-four starts with one.
 */
export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    const long = LONG.exec(arg);
    const short = SHORT_FLAG.exec(arg);
    if (!long && !short) {
      positionals.push(arg);
      continue;
    }
    const name = long ? long[1]! : SHORT[short![1]!];
    if (!name || (!SWITCHES.has(name) && !VALUES.has(name))) throw usage(`Unknown option: ${arg}`);
    const inline = long?.[2];
    if (SWITCHES.has(name)) {
      if (inline !== undefined) throw usage(`--${name} takes no value.`);
      flags.set(name, true);
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw usage(`--${name} needs a value.`);
    flags.set(name, value);
  }
  const [command = null, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function on(args: Args, name: string): boolean {
  return args.flags.get(name) === true;
}

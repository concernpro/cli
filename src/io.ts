/**
 * Everything the commands reach outside for: the terminal, files, the
 * browser, the network and the clock. The CLI is given the real ones; the
 * tests give their own.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import type { Fetch } from "./oauth.ts";

export type Io = {
  /** What the command answers: what a script reads. */
  out: (text: string) => void;
  /** What it says along the way: questions, progress, warnings. */
  err: (text: string) => void;
  env: Record<string, string | undefined>;
  /** A person is at the terminal, and can be asked. */
  interactive: boolean;
  /** Asks for one line. Null when the input has ended. */
  ask: (prompt: string) => Promise<string | null>;
  readStdin: () => Promise<string>;
  readFile: (path: string) => string;
  /** Opens an address in the browser. False where there seems to be none to open it in. */
  openBrowser: (url: string) => Promise<boolean>;
  fetch: Fetch;
  now: () => number;
};

/** The command that hands an address to the system's browser, or null on a machine with no screen. */
export function browserCommand(platform: string, env: Record<string, string | undefined>): [string, string[]] | null {
  if (platform === "darwin") return ["open", []];
  // Not `start`, which is a word of cmd.exe and reads & in an address as the end of the command.
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler"]];
  // Over ssh, or on a server, there is nothing to open: the address is printed instead.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return ["xdg-open", []];
}

export function realIo(): Io & { close: () => void } {
  let lines: Interface | null = null;
  const waiting: ((line: string | null) => void)[] = [];
  const buffered: (string | null)[] = [];
  // One reader for the whole run. Lines typed or piped ahead of a question wait for it.
  const reader = () => {
    if (lines) return;
    lines = createInterface({ input: process.stdin, terminal: false });
    lines.on("line", (line) => (waiting.shift() ?? ((value) => buffered.push(value)))(line));
    lines.on("close", () => {
      for (const resolve of waiting.splice(0)) resolve(null);
      buffered.push(null);
    });
  };

  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: (prompt) => {
      reader();
      process.stderr.write(prompt);
      if (buffered.length > 0) {
        const line = buffered[0] === null ? null : (buffered.shift() as string);
        return Promise.resolve(line);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    readFile: (path) => readFileSync(path, "utf8"),
    openBrowser: async (url) => {
      const command = browserCommand(process.platform, process.env);
      if (!command) return false;
      const [program, args] = command;
      return new Promise((resolve) => {
        const child = spawn(program, [...args, url], { stdio: "ignore", detached: true });
        child.once("error", () => resolve(false));
        child.once("spawn", () => {
          child.unref();
          resolve(true);
        });
      });
    },
    fetch: globalThis.fetch,
    now: Date.now,
    // The reader holds the terminal open: the process ends only once it is closed.
    close: () => (lines as Interface | null)?.close(),
  };
}

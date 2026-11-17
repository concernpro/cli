import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

export type Run = { code: number; out: string; err: string };

/**
 * A terminal for the CLI: what it prints is kept, what it asks is answered
 * from a list, and the browser is a fetch that follows concern.pro's
 * redirect back to the CLI's listener, as a person pressing "Allow" does.
 */
export class Terminal {
  readonly dir = mkdtempSync(join(tmpdir(), "concern-cli-"));
  readonly opened: string[] = [];
  interactive = false;
  answers: string[] = [];
  asked: string[] = [];
  stdin = "";
  files: Record<string, string> = {};
  now = () => Date.now();
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  async run(...argv: string[]): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      env: { CONCERN_CONFIG_DIR: this.dir, CONCERN_URL: this.origin },
      interactive: this.interactive,
      ask: async (prompt) => {
        this.asked.push(prompt);
        return this.answers.length > 0 ? this.answers.shift()! : null;
      },
      readStdin: async () => this.stdin,
      readFile: (path) => {
        if (!(path in this.files)) throw new Error("ENOENT: no such file");
        return this.files[path]!;
      },
      openBrowser: async (url) => {
        this.opened.push(url);
        const approval = await fetch(url, { redirect: "manual" });
        const back = approval.headers.get("location");
        if (back) await fetch(back);
        return true;
      },
      fetch: globalThis.fetch,
      now: () => this.now(),
    };
    const code = await main(argv, io);
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

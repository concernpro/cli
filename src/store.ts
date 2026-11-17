/**
 * What the CLI keeps on the person's computer, in their configuration folder:
 * the sign-in for each Concern address, and the plans made from it.
 *
 * - credentials.json holds the tokens. It is written readable by its owner
 *   only, and replaced whole, so a write that is cut off leaves the old file.
 * - plans.json holds each plan with its arguments, so that a request whose
 *   answer was lost can be sent again under the same plan id, which the
 *   server reads as the same request.
 *
 * Both are keyed by the address of the site, so that the sign-ins of two
 * addresses never mix.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Deployment } from "./deployment.ts";

/** Where the CLI keeps its files: $CONCERN_CONFIG_DIR, or the system's configuration folder. */
export function configDir(env: Record<string, string | undefined>, platform = process.platform): string {
  if (env.CONCERN_CONFIG_DIR) return env.CONCERN_CONFIG_DIR;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "concern");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "concern");
}

export type Account = { email: string; team: string; workspace: string };

export type Credentials = {
  /** The id this CLI registered under at the last sign-in. */
  clientId: string;
  tokenEndpoint: string;
  /** The MCP server the token is for. */
  resource: string;
  accessToken: string;
  /** Replaced each time it is used: only the latest one is good. */
  refreshToken: string;
  /** Milliseconds since 1970 at which the access token runs out. */
  expiresAt: number;
  /** Who signed in, and where, as get_workspace last said. */
  account?: Account;
};

export type SavedPlan = {
  plan: string;
  deployment: Deployment;
  /** The work and its estimate in words, as the plan was shown. */
  summary: string;
  createdAt: number;
  /** The reference it went under, once the server said it was sent. */
  sent?: string;
};

/** Sent plans are forgotten after this long. The site lists a request for ninety days. */
const KEEP_SENT_MS = 90 * 24 * 60 * 60 * 1000;
/** Plans never sent are forgotten sooner: a plan is a quote of the day it was made. */
const KEEP_UNSENT_MS = 30 * 24 * 60 * 60 * 1000;

type ByOrigin<T> = Record<string, T>;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Replaces a file whole: the new text goes to a file beside it, which then takes its name. */
function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export class Store {
  readonly dir: string;
  readonly origin: string;

  constructor(dir: string, origin: string) {
    this.dir = dir;
    this.origin = origin;
  }

  credentials(): Credentials | null {
    return readJson<ByOrigin<Credentials>>(join(this.dir, "credentials.json"))?.[this.origin] ?? null;
  }

  saveCredentials(credentials: Credentials | null): void {
    const all = readJson<ByOrigin<Credentials>>(join(this.dir, "credentials.json")) ?? {};
    if (credentials) all[this.origin] = credentials;
    else delete all[this.origin];
    if (Object.keys(all).length === 0) rmSync(join(this.dir, "credentials.json"), { force: true });
    else writeJson(this.dir, "credentials.json", all);
  }

  plans(now = Date.now()): SavedPlan[] {
    const all = readJson<ByOrigin<SavedPlan[]>>(join(this.dir, "plans.json")) ?? {};
    return (all[this.origin] ?? []).filter((plan) => now - plan.createdAt < (plan.sent ? KEEP_SENT_MS : KEEP_UNSENT_MS));
  }

  plan(id: string): SavedPlan | null {
    return this.plans().find((plan) => plan.plan === id) ?? null;
  }

  savePlan(plan: SavedPlan, now = Date.now()): void {
    const all = readJson<ByOrigin<SavedPlan[]>>(join(this.dir, "plans.json")) ?? {};
    all[this.origin] = [...this.plans(now).filter((kept) => kept.plan !== plan.plan), plan];
    writeJson(this.dir, "plans.json", all);
  }
}

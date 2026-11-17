/**
 * Hiring: a plan first, then the request.
 *
 * `concern hire` makes a plan with plan_deployment, which prices the work and
 * sends nothing, keeps it on this computer, shows it, and sends it with
 * request_deployment once the person says so. `concern send <plan>` sends a
 * kept plan.
 *
 * A request goes under a reference the server makes from the account and the
 * plan id. So sending one plan twice, after an answer that was lost or a team
 * that did not answer in time, is one request to the team, and the second
 * send answers with the reference of the first.
 */
import { flag, on } from "../args.ts";
import { dataOf, oneLine, printJson, type Context } from "../context.ts";
import { answer, complete, draftFromFlags, missingFlags, nextQuestion, type Deployment, type Draft, type Question } from "../deployment.ts";
import { CliError, EXIT, usage, type ExitCode } from "../errors.ts";
import type { SavedPlan } from "../store.ts";

async function taskText(context: Context): Promise<string | undefined> {
  const { args, io } = context;
  const file = flag(args, "task-file");
  const inline = flag(args, "task") ?? (args.positionals.length > 0 ? args.positionals.join(" ") : undefined);
  if (file !== undefined && inline !== undefined) throw usage("Give the task once: as text, or with --task-file.");
  if (file === undefined) return inline;
  try {
    return file === "-" ? await io.readStdin() : io.readFile(file);
  } catch (error) {
    throw new CliError(`Could not read ${file}: ${(error as Error).message}`);
  }
}

function printQuestion(context: Context, question: Question): void {
  const { err } = context.io;
  err("");
  err(question.prompt);
  question.choices?.forEach((choice, index) => {
    const fallback = choice.value === question.fallback ? " (Enter)" : "";
    err(`  ${index + 1}. ${choice.label}${fallback}${choice.hint ? ` — ${choice.hint}` : ""}`);
  });
}

/** Lines until an empty one. Null when the input ended before anything was written. */
async function readLines(context: Context): Promise<string | null> {
  const lines: string[] = [];
  for (;;) {
    const line = await context.io.ask(lines.length === 0 ? "> " : "  ");
    if (line === null) return lines.length > 0 ? lines.join("\n") : null;
    if (line.trim() === "") return lines.join("\n");
    lines.push(line);
  }
}

/** The prompt of a line: what Enter alone answers, where it answers something. */
function promptFor(question: Question): string {
  if (question.fallback === undefined) return "> ";
  const index = question.choices?.findIndex((choice) => choice.value === question.fallback) ?? -1;
  return `[${index >= 0 ? index + 1 : question.fallback}] `;
}

/** Asks for what the flags did not say, a question at a time, until the draft is whole. */
async function askFor(context: Context, start: Draft): Promise<Draft> {
  let draft = start;
  for (let question = nextQuestion(draft); question; question = nextQuestion(draft)) {
    printQuestion(context, question);
    for (;;) {
      const raw = question.multiline ? await readLines(context) : await context.io.ask(promptFor(question));
      if (raw === null) throw new CliError("Stopped. Nothing was sent.");
      const taken = answer(draft, question, raw);
      if (taken.ok) {
        draft = taken.draft;
        break;
      }
      context.io.err(taken.error);
    }
  }
  return draft;
}

async function confirm(context: Context, prompt: string): Promise<boolean> {
  const reply = await context.io.ask(prompt);
  return reply !== null && /^(y|yes)$/i.test(reply.trim());
}

function printPlan(context: Context, saved: SavedPlan, view: Record<string, unknown>): void {
  const { out } = context.io;
  const estimate = (view.estimate ?? {}) as { text?: string };
  out("");
  out(`  ${view.work}`);
  out(`  Estimate:  ${estimate.text ?? "quoted individually"}`);
  out(`  Speed:     ${view.speed}. ${view.starts}.`);
  out(`  Task:      ${oneLine(saved.deployment.task, 200)}`);
  out(`  Plan:      ${saved.plan}`);
  out("");
}

export async function hire(context: Context): Promise<ExitCode> {
  const { args } = context;
  let draft = draftFromFlags({
    product: flag(args, "product"),
    engineer: on(args, "engineer"),
    verifier: on(args, "verifier"),
    mode: flag(args, "mode"),
    subscription: on(args, "subscription"),
    type: flag(args, "type"),
    seats: flag(args, "seats"),
    speed: flag(args, "speed"),
    standard: on(args, "standard"),
    priority: on(args, "priority"),
    task: await taskText(context),
  });
  // Signed in before any question: a person is not asked all of it to be told at the end that they must sign in.
  context.session.credentials();
  if (context.interactive) draft = await askFor(context, draft);
  const deployment = complete(draft);
  if (!deployment) throw usage(`Not enough to make a plan. Missing:\n  ${missingFlags(draft).join("\n  ")}`);

  const planned = await context.mcp().callTool("plan_deployment", { ...deployment });
  if (planned.isError) throw new CliError(planned.text);
  const view = dataOf(planned, "plan_deployment");
  const plan = ((view.input ?? {}) as { plan?: unknown }).plan;
  if (typeof plan !== "string") throw new CliError("Concern made no plan id for this work.");
  const estimate = (view.estimate ?? {}) as { text?: string };
  const saved: SavedPlan = { plan, deployment, summary: `${view.work}, ${estimate.text ?? "quoted individually"}`, createdAt: context.io.now() };
  context.store.savePlan(saved, context.io.now());

  if (!context.json) printPlan(context, saved, view);
  // --plan-only wins over --yes: of the two, it is the one that sends nothing.
  const send =
    !on(args, "plan-only") && (on(args, "yes") || (context.interactive && (await confirm(context, "Send this request to Concern's team? Nothing is charged before you approve a quote. [y/N] "))));
  if (!send) {
    if (context.json) printJson(context, { plan, deployment, estimate: view.estimate, sent: false });
    else context.io.out(`Not sent. To send it: concern send ${plan}`);
    return EXIT.ok;
  }
  return deliver(context, saved);
}

/** Sends a kept plan. Without a plan id, lists those not sent yet. */
export async function send(context: Context): Promise<ExitCode> {
  const id = context.args.positionals[0];
  if (!id) {
    const waiting = context.store.plans(context.io.now()).filter((plan) => !plan.sent);
    if (context.json) printJson(context, waiting);
    else if (waiting.length === 0) context.io.out("No plans waiting to be sent. Make one with: concern hire");
    else {
      context.io.out("Plans not sent yet:");
      for (const plan of waiting) context.io.out(`  ${plan.plan}  ${new Date(plan.createdAt).toISOString().slice(0, 10)}  ${plan.summary}`);
      context.io.out("Send one with: concern send <plan>");
    }
    return EXIT.ok;
  }
  const saved = context.store.plan(id);
  if (!saved) throw new CliError(`There is no plan ${id} on this computer. concern send lists the plans waiting here.`);
  if (saved.sent) {
    if (context.json) printJson(context, { plan: saved.plan, sent: saved.sent, repeated: true });
    else context.io.out(`This plan was sent already, under the reference ${saved.sent}. Follow it with: concern requests`);
    return EXIT.ok;
  }
  return deliver(context, saved);
}

async function deliver(context: Context, saved: SavedPlan): Promise<ExitCode> {
  const deployment: Deployment = saved.deployment;
  const outcome = await context.mcp().callTool("request_deployment", { ...deployment, plan: saved.plan });
  if (outcome.isError) {
    // Out of time is not a refusal: the request left, and may have arrived. The same plan goes under the same reference.
    if (outcome.data?.unsure === true) {
      context.io.err(outcome.text);
      context.io.err(`Sending it again is safe: concern send ${saved.plan}`);
      if (context.json) printJson(context, { plan: saved.plan, sent: null, unsure: true });
      return EXIT.unsure;
    }
    throw new CliError(outcome.text);
  }
  const data = dataOf(outcome, "request_deployment");
  const reference = typeof data.sent === "string" ? data.sent : null;
  if (!reference) throw new CliError(`Concern did not say under which reference the request went. Check with: concern requests`);
  context.store.savePlan({ ...saved, sent: reference }, context.io.now());

  if (context.json) {
    printJson(context, { plan: saved.plan, deployment, estimate: data.estimate ?? null, sent: reference, repeated: data.repeated === true });
    return EXIT.ok;
  }
  if (data.repeated === true) {
    context.io.out(`This plan was sent before, under the reference ${reference}. Nothing was sent again.`);
  } else {
    const email = context.store.credentials()?.account?.email;
    context.io.out(`Sent. Reference ${reference}.`);
    context.io.out(`Concern's team will write${email ? ` to ${email}` : ""} with a quote. Nothing is charged and nothing starts before you approve it.`);
  }
  context.io.out("Follow it with: concern requests");
  return EXIT.ok;
}

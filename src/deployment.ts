/**
 * What a hire is made of, as concern.pro's MCP tools take it: who does the
 * work, one task or a subscription, the kind of work or how many seats, how
 * fast, and the task in words. The flags fill in what they can; the questions
 * ask for the rest.
 *
 * The CLI knows the kinds of work by name to offer them in a menu, and knows
 * no price: every estimate it shows is the one plan_deployment returns, read
 * from the site's catalog. The server checks everything again, so a kind of
 * work added there and not here yet can still be named with --type.
 */
import { usage } from "./errors.ts";

export type Product = "engineer" | "verifier";
export type Mode = "task" | "subscription";
export type Speed = "standard" | "priority";

/** The arguments of plan_deployment and request_deployment, less the plan id. */
export type Deployment = {
  product: Product;
  mode: Mode;
  work_type?: string;
  seats?: number;
  speed: Speed;
  task: string;
};

export type Draft = Partial<Deployment>;

export const PRODUCTS: Record<Product, { label: string; summary: string }> = {
  engineer: { label: "Engineer", summary: "Builds it: features, redesigns, integrations, landing pages." },
  verifier: { label: "Verifier", summary: "Checks it: tests, reviews and release sign-off for code you already write." },
};

export const WORK_TYPES: { id: string; product: Product; label: string; example: string }[] = [
  { id: "feature", product: "engineer", label: "Feature", example: "Add-to-cart flow, countdown timer, signup form" },
  { id: "landing", product: "engineer", label: "Landing page", example: "Designed, built and launched" },
  { id: "integration", product: "engineer", label: "Integration", example: "Payments, CRM, analytics" },
  { id: "redesign", product: "engineer", label: "Redesign", example: "A mid-size product or site" },
  { id: "custom-build", product: "engineer", label: "Something else", example: "Describe it and get a quote" },
  { id: "review", product: "verifier", label: "Code review", example: "A second pair of eyes on AI-written pull requests" },
  { id: "tests", product: "verifier", label: "Test suite", example: "Coverage for a feature or a service" },
  { id: "release", product: "verifier", label: "Release sign-off", example: "A regression run before production" },
  { id: "custom-verify", product: "verifier", label: "Something else", example: "Describe it and get a quote" },
];

export const SPEEDS: Record<Speed, { label: string; summary: string }> = {
  standard: { label: "Standard", summary: "Starts the next business day" },
  priority: { label: "Priority", summary: "Starts the same day, front of the queue, at a higher price" },
};

export const MAX_SEATS = 20;
/** What the server takes as a task: a sentence or two at least, four thousand characters at most. */
export const MIN_TASK = 10;
export const MAX_TASK = 4000;

function isProduct(value: string): value is Product {
  return value === "engineer" || value === "verifier";
}

function isMode(value: string): value is Mode {
  return value === "task" || value === "subscription";
}

function isSpeed(value: string): value is Speed {
  return value === "standard" || value === "priority";
}

/** Why a task cannot be sent as it is, or null. */
export function taskProblem(task: string): string | null {
  if (task.length < MIN_TASK) return "Describe the work in a sentence or two.";
  if (task.length > MAX_TASK) return `The task must be ${MAX_TASK} characters at most; it has ${task.length}.`;
  return null;
}

function seatsOf(raw: string): number | null {
  if (!/^\s*\d{1,3}\s*$/.test(raw)) return null;
  const seats = Number(raw);
  return seats >= 1 && seats <= MAX_SEATS ? seats : null;
}

/** One of two ways to say a thing, said at most one way. */
function oneOf<T extends string>(name: string, given: (T | undefined)[]): T | undefined {
  const said = [...new Set(given.filter((value): value is T => value !== undefined))];
  if (said.length > 1) throw usage(`Choose one ${name}: ${said.join(" or ")}.`);
  return said[0];
}

export type DraftFlags = {
  product?: string;
  engineer?: boolean;
  verifier?: boolean;
  mode?: string;
  subscription?: boolean;
  type?: string;
  seats?: string;
  speed?: string;
  standard?: boolean;
  priority?: boolean;
  task?: string;
};

/** What the flags say of the hire. A flag that contradicts another, or a value that is not one, is refused. */
export function draftFromFlags(flags: DraftFlags): Draft {
  const draft: Draft = {};
  if (flags.product !== undefined && !isProduct(flags.product)) throw usage(`--product must be engineer or verifier, not "${flags.product}".`);
  draft.product = oneOf<Product>("product", [flags.product as Product | undefined, flags.engineer ? "engineer" : undefined, flags.verifier ? "verifier" : undefined]);

  if (flags.mode !== undefined && !isMode(flags.mode)) throw usage(`--mode must be task or subscription, not "${flags.mode}".`);
  const mode = oneOf<Mode>("mode", [
    flags.mode as Mode | undefined,
    flags.subscription ? "subscription" : undefined,
    // A kind of work is only for one task, and seats only for a subscription.
    flags.type !== undefined ? "task" : undefined,
    flags.seats !== undefined ? "subscription" : undefined,
  ]);
  draft.mode = mode;

  if (flags.type !== undefined) {
    const known = WORK_TYPES.find((type) => type.id === flags.type);
    if (known && draft.product && known.product !== draft.product) {
      throw usage(`--type ${flags.type} is ${known.product} work. For ${draft.product} work: ${typesFor(draft.product).join(", ")}.`);
    }
    if (known) draft.product = known.product;
    draft.work_type = flags.type;
  }
  if (flags.seats !== undefined) {
    const seats = seatsOf(flags.seats);
    if (seats === null) throw usage(`--seats must be a whole number from 1 to ${MAX_SEATS}.`);
    draft.seats = seats;
  }

  if (flags.speed !== undefined && !isSpeed(flags.speed)) throw usage(`--speed must be standard or priority, not "${flags.speed}".`);
  draft.speed = oneOf<Speed>("speed", [flags.speed as Speed | undefined, flags.standard ? "standard" : undefined, flags.priority ? "priority" : undefined]);

  if (flags.task !== undefined) {
    const task = flags.task.trim();
    const problem = taskProblem(task);
    if (problem) throw usage(`--task: ${problem}`);
    draft.task = task;
  }
  return draft;
}

function typesFor(product: Product): string[] {
  return WORK_TYPES.filter((type) => type.product === product).map((type) => type.id);
}

export type Choice = { value: string; label: string; hint?: string };

export type Question = {
  field: keyof Deployment;
  prompt: string;
  /** A menu, or a line of text where there is none. */
  choices?: Choice[];
  /** What an empty answer means, where it means something. */
  fallback?: string;
  /** For a task: its lines run until an empty one. */
  multiline?: boolean;
};

/**
 * The next thing to ask, or null when the draft is a whole deployment. The
 * order is the one of the first task on concern.pro: what is needed first,
 * then who does it and how.
 */
export function nextQuestion(draft: Draft): Question | null {
  if (draft.task === undefined) {
    return { field: "task", prompt: "What do you need done? Write it as the team should read it: what, where, by when. End with an empty line.", multiline: true };
  }
  if (draft.product === undefined) {
    return {
      field: "product",
      prompt: "Who should do it?",
      choices: (Object.keys(PRODUCTS) as Product[]).map((product) => ({ value: product, label: PRODUCTS[product].label, hint: PRODUCTS[product].summary })),
      fallback: "engineer",
    };
  }
  if (draft.mode === undefined) {
    return {
      field: "mode",
      prompt: "One task, or a monthly subscription?",
      choices: [
        { value: "task", label: "One task", hint: "A fixed starting price for this piece of work" },
        { value: "subscription", label: "Subscription", hint: "Standing capacity, billed per seat per month" },
      ],
      fallback: "task",
    };
  }
  if (draft.mode === "task" && draft.work_type === undefined) {
    return {
      field: "work_type",
      prompt: "What kind of work is it?",
      choices: WORK_TYPES.filter((type) => type.product === draft.product).map((type) => ({ value: type.id, label: type.label, hint: type.example })),
    };
  }
  if (draft.mode === "subscription" && draft.seats === undefined) {
    return { field: "seats", prompt: `How many ${draft.product === "verifier" ? "verifiers" : "engineers"}? (1 to ${MAX_SEATS})`, fallback: "1" };
  }
  if (draft.speed === undefined) {
    return {
      field: "speed",
      prompt: "How soon?",
      choices: (Object.keys(SPEEDS) as Speed[]).map((speed) => ({ value: speed, label: SPEEDS[speed].label, hint: SPEEDS[speed].summary })),
      fallback: "standard",
    };
  }
  return null;
}

/**
 * Takes an answer to a question. A menu is answered by its number or by the
 * value; an empty answer is the question's fallback. An answer that is none
 * of these is an error to show, and the question is asked again.
 */
export function answer(draft: Draft, question: Question, raw: string): { ok: true; draft: Draft } | { ok: false; error: string } {
  const text = raw.trim() || question.fallback || "";
  if (question.choices) {
    const index = /^\d+$/.test(text) ? Number(text) - 1 : -1;
    const choice = question.choices[index] ?? question.choices.find((item) => item.value === text.toLowerCase());
    if (!choice) return { ok: false, error: `Answer with a number from 1 to ${question.choices.length}.` };
    return { ok: true, draft: { ...draft, [question.field]: choice.value } };
  }
  if (question.field === "seats") {
    const seats = seatsOf(text);
    return seats === null ? { ok: false, error: `A whole number from 1 to ${MAX_SEATS}.` } : { ok: true, draft: { ...draft, seats } };
  }
  const problem = taskProblem(text);
  return problem ? { ok: false, error: problem } : { ok: true, draft: { ...draft, task: text } };
}

/** The draft as a deployment, if nothing is missing. Speed is standard unless asked for. */
export function complete(draft: Draft): Deployment | null {
  const { product, mode, task } = draft;
  if (!product || !mode || !task) return null;
  const speed = draft.speed ?? "standard";
  if (mode === "task") return draft.work_type ? { product, mode, work_type: draft.work_type, speed, task } : null;
  return { product, mode, seats: draft.seats ?? 1, speed, task };
}

/** The flags still missing for a draft to be sent without questions: what a script is told. */
export function missingFlags(draft: Draft): string[] {
  const missing: string[] = [];
  if (!draft.task) missing.push('--task "<what you need done>" (or --task-file <path>)');
  if (!draft.product) missing.push("--engineer or --verifier");
  if (!draft.mode) missing.push("--type <kind of work> for one task, or --seats <n> for a subscription");
  else if (draft.mode === "task" && !draft.work_type) missing.push(`--type <${draft.product ? typesFor(draft.product).join("|") : "kind of work"}>`);
  return missing;
}

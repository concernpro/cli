import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.ts";
import { answer, complete, draftFromFlags, missingFlags, nextQuestion } from "../src/deployment.ts";
import { CliError, EXIT } from "../src/errors.ts";
import { browserCommand } from "../src/io.ts";
import { readAnswer } from "../src/mcp.ts";
import { discover, listen, normalizeOrigin, pkce } from "../src/oauth.ts";

describe("the command line", () => {
  it("reads commands, flags with values in both spellings, and switches", () => {
    const args = parseArgs(["hire", "--type=feature", "--seats", "2", "-y", "fix", "the", "login"]);
    assert.equal(args.command, "hire");
    assert.equal(args.flags.get("type"), "feature");
    assert.equal(args.flags.get("seats"), "2");
    assert.equal(args.flags.get("yes"), true);
    assert.deepEqual(args.positionals, ["fix", "the", "login"]);
  });

  it("takes a plan id that starts with a dash for an argument, not an option", () => {
    assert.deepEqual(parseArgs(["send", "-iYyX0CcseNXlhFRKuNXmBvhR5z4Pyce"]).positionals, ["-iYyX0CcseNXlhFRKuNXmBvhR5z4Pyce"]);
    assert.deepEqual(parseArgs(["send", "--", "--anything"]).positionals, ["--anything"]);
    // A value may start with one too.
    assert.equal(parseArgs(["hire", "--task", "-x marks the spot on the map"]).flags.get("task"), "-x marks the spot on the map");
  });

  it("refuses an unknown flag and a flag without its value", () => {
    assert.throws(() => parseArgs(["hire", "--fast"]), (error: CliError) => error.exitCode === EXIT.usage);
    assert.throws(() => parseArgs(["hire", "--type"]), /needs a value/);
    assert.throws(() => parseArgs(["hire", "--yes=no"]), /takes no value/);
  });
});

describe("a deployment", () => {
  it("is read from flags: a kind of work says who does it and that it is one task", () => {
    assert.deepEqual(complete(draftFromFlags({ type: "review", task: "Review our open pull requests" })), {
      product: "verifier",
      mode: "task",
      work_type: "review",
      speed: "standard",
      task: "Review our open pull requests",
    });
    assert.deepEqual(complete(draftFromFlags({ engineer: true, seats: "3", priority: true, task: "Three engineers on the app" })), {
      product: "engineer",
      mode: "subscription",
      seats: 3,
      speed: "priority",
      task: "Three engineers on the app",
    });
  });

  it("refuses flags that contradict each other", () => {
    assert.throws(() => draftFromFlags({ engineer: true, verifier: true }), /Choose one product/);
    assert.throws(() => draftFromFlags({ engineer: true, type: "review" }), /review is verifier work/);
    assert.throws(() => draftFromFlags({ type: "feature", seats: "2" }), /Choose one mode/);
    assert.throws(() => draftFromFlags({ standard: true, priority: true }), /Choose one speed/);
    assert.throws(() => draftFromFlags({ seats: "21" }), /1 to 20/);
    assert.throws(() => draftFromFlags({ task: "help" }), /sentence or two/);
  });

  it("leaves a kind of work the CLI does not know for the server to judge", () => {
    assert.equal(draftFromFlags({ engineer: true, type: "mobile-app" }).work_type, "mobile-app");
  });

  it("asks the task first, then who, how, what kind and how soon", () => {
    let draft = {};
    const asked: string[] = [];
    const replies: Record<string, string> = { task: "Build a landing page for the launch", product: "1", mode: "1", work_type: "2", speed: "" };
    for (let question = nextQuestion(draft); question; question = nextQuestion(draft)) {
      asked.push(question.field);
      const taken = answer(draft, question, replies[question.field]!);
      assert.ok(taken.ok);
      draft = taken.draft;
    }
    assert.deepEqual(asked, ["task", "product", "mode", "work_type", "speed"]);
    assert.deepEqual(complete(draft), { product: "engineer", mode: "task", work_type: "landing", speed: "standard", task: "Build a landing page for the launch" });
  });

  it("asks for seats, not a kind of work, for a subscription", () => {
    const question = nextQuestion({ task: "Standing capacity for QA", product: "verifier", mode: "subscription" })!;
    assert.equal(question.field, "seats");
    assert.deepEqual(answer({}, question, "40"), { ok: false, error: "A whole number from 1 to 20." });
  });

  it("names the flags a script still has to give", () => {
    assert.deepEqual(missingFlags({ product: "engineer", mode: "task", task: "x".repeat(20) }), ["--type <feature|landing|integration|redesign|custom-build>"]);
  });
});

describe("signing in", () => {
  it("makes PKCE as RFC 7636 does", () => {
    // The example of RFC 7636, appendix B.
    assert.equal(pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const fresh = pkce();
    assert.match(fresh.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.match(fresh.challenge, /^[A-Za-z0-9_-]{43}$/);
  });

  it("sends tokens over https only, but to a copy of the site on this computer", () => {
    assert.equal(normalizeOrigin("https://concern.pro/mcp"), "https://concern.pro");
    assert.equal(normalizeOrigin("http://localhost:3000"), "http://localhost:3000");
    assert.throws(() => normalizeOrigin("http://concern.pro"), /https/);
  });

  it("refuses a site whose documents send the sign-in somewhere else", async () => {
    const documents: Record<string, unknown> = {
      "https://concern.pro/.well-known/oauth-protected-resource/mcp": { resource: "https://concern.pro/mcp", authorization_servers: ["https://concern.pro"] },
      "https://concern.pro/.well-known/oauth-authorization-server": {
        authorization_endpoint: "https://concern.pro/api/oauth/authorize",
        token_endpoint: "https://elsewhere.example/token",
        registration_endpoint: "https://concern.pro/api/oauth/register",
        code_challenge_methods_supported: ["S256"],
      },
    };
    const fetcher = (async (url: string) => Response.json(documents[url])) as typeof fetch;
    await assert.rejects(discover(fetcher, "https://concern.pro"), /token_endpoint/);
  });

  it("takes the browser's answer only with the state it sent", async () => {
    const listener = await listen("the-state", 5000);
    const wrong = await fetch(`${listener.redirectUri}?code=stolen&state=other`);
    assert.equal(wrong.status, 400);
    const right = await fetch(`${listener.redirectUri}?code=the-code&state=the-state`);
    assert.equal(right.status, 200);
    assert.equal(await listener.code, "the-code");
  });

  it("gives up after its time", async () => {
    const listener = await listen("s", 20);
    await assert.rejects(listener.code, /took too long/);
  });
});

describe("the MCP client", () => {
  it("reads an answer from JSON and from an event stream", () => {
    assert.deepEqual(readAnswer("application/json", '{"jsonrpc":"2.0","id":3,"result":{"ok":true}}', 3)?.result, { ok: true });
    const stream = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0",\ndata: "id":4,"result":{"ok":1}}\n\n';
    assert.deepEqual(readAnswer("text/event-stream", stream, 4)?.result, { ok: 1 });
  });
});

describe("the browser", () => {
  it("is not opened where there is no screen", () => {
    assert.equal(browserCommand("linux", {}), null);
    assert.deepEqual(browserCommand("linux", { DISPLAY: ":0" }), ["xdg-open", []]);
    assert.deepEqual(browserCommand("darwin", {}), ["open", []]);
  });
});

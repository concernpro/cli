import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { EXIT } from "../src/errors.ts";
import { FakeConcern } from "./fake-concern.ts";
import { Terminal } from "./harness.ts";

const TASK = "Add a signup form with email confirmation to app.acme.test";

describe("concern, against a stand-in for concern.pro", () => {
  let concern: FakeConcern;
  let terminal: Terminal;

  before(async () => {
    concern = await new FakeConcern().start();
  });
  after(() => concern.stop());
  beforeEach(() => {
    terminal?.cleanup();
    terminal = new Terminal(concern.origin);
    concern.accessSeconds = 3600;
    concern.deny = false;
    concern.timeOutNextSend = false;
  });

  it("signs in through the browser and shows the workspace it was let into", async () => {
    const run = await terminal.run("login");
    assert.equal(run.code, EXIT.ok, run.err);
    assert.match(run.out, /Signed in as lead@acme\.test/);
    assert.match(run.out, /Workspace: {2}Main/);
    assert.match(run.out, /Connected: {2}Linear/);
    // The browser was sent to approve, with PKCE and the MCP server named as the resource.
    const url = new URL(terminal.opened[0]!);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("resource"), `${concern.origin}/mcp`);
    assert.match(url.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The tokens are readable by their owner only.
    const file = join(terminal.dir, "credentials.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8"))[concern.origin].account.email, "lead@acme.test");
  });

  it("says so when the person does not allow the CLI, and keeps nothing", async () => {
    concern.deny = true;
    const run = await terminal.run("login");
    assert.equal(run.code, EXIT.failed);
    assert.match(run.err, /did not allow/);
    assert.equal((await terminal.run("whoami")).code, EXIT.signedOut);
  });

  it("asks nothing of someone signed out: it tells them to sign in first", async () => {
    terminal.interactive = true;
    const run = await terminal.run("hire");
    assert.equal(run.code, EXIT.signedOut);
    assert.deepEqual(terminal.asked, []);
  });

  it("hires from flags alone, for a script", async () => {
    await terminal.run("login");
    const run = await terminal.run("hire", "--engineer", "--type", "feature", "--task", TASK, "--yes");
    assert.equal(run.code, EXIT.ok, run.err);
    assert.match(run.out, /Estimate: {2}from \$300/);
    assert.match(run.out, /Sent\. Reference CR-/);
    assert.match(run.out, /write to lead@acme\.test with a quote/);
    const sent = concern.sent.at(-1)!;
    assert.deepEqual({ ...sent.args, plan: undefined }, { product: "engineer", mode: "task", work_type: "feature", speed: "standard", task: TASK, plan: undefined });
  });

  it("tells a script which flags are missing, and sends nothing", async () => {
    await terminal.run("login");
    const before = concern.sent.length;
    const run = await terminal.run("hire", "--task", TASK);
    assert.equal(run.code, EXIT.usage);
    assert.match(run.err, /--engineer or --verifier/);
    assert.equal(concern.sent.length, before);
  });

  it("asks a person for what the flags did not say, then sends once they agree", async () => {
    await terminal.run("login");
    terminal.interactive = true;
    terminal.answers = [
      "Review the pull requests our AI agent opens",
      "on github.com/acme/app, every day this week.",
      "", // the task ends
      "2", // a verifier
      "", // one task, the default
      "1", // code review
      "2", // priority
      "y",
    ];
    const run = await terminal.run("hire");
    assert.equal(run.code, EXIT.ok, run.err);
    assert.match(run.out, /Verifier, Code review/);
    assert.match(run.out, /Estimate: {2}from \$225/);
    const sent = concern.sent.at(-1)!;
    assert.equal(sent.args.task, "Review the pull requests our AI agent opens\non github.com/acme/app, every day this week.");
    assert.equal(sent.args.work_type, "review");
    assert.equal(sent.args.speed, "priority");
  });

  it("asks again after an answer that is not one of the choices", async () => {
    await terminal.run("login");
    terminal.interactive = true;
    terminal.answers = ["9", "engineer", "n"];
    const run = await terminal.run("hire", "--type", "landing", "--task", TASK, "--mode", "task", "--standard");
    // --type landing says engineer already: no question about who, so "9" is the answer to nothing.
    assert.equal(run.code, EXIT.ok, run.err);
    assert.match(run.out, /Not sent\. To send it: concern send /);
  });

  it("keeps a plan that was not sent, lists it, and sends it later", async () => {
    await terminal.run("login");
    const before = concern.sent.length;
    // --plan-only sends nothing, even beside --yes.
    const planned = await terminal.run("hire", "--engineer", "--seats", "2", "--task", "Two engineers on our checkout from Monday", "--plan-only", "--yes");
    assert.equal(concern.sent.length, before);
    assert.equal(planned.code, EXIT.ok, planned.err);
    assert.match(planned.out, /Estimate: {2}from \$5000/);
    const plan = /concern send (\S+)/.exec(planned.out)![1]!;

    const listed = await terminal.run("send");
    assert.match(listed.out, new RegExp(plan));

    const sent = await terminal.run("send", plan);
    assert.equal(sent.code, EXIT.ok, sent.err);
    assert.equal(concern.sent.length, before + 1);
    assert.equal(concern.sent.at(-1)!.args.seats, 2);

    // Sent once: asked again, it says so and calls nobody.
    const calls = concern.calls.length;
    const again = await terminal.run("send", plan);
    assert.match(again.out, /sent already, under the reference CR-/);
    assert.equal(concern.calls.length, calls);
    assert.match((await terminal.run("send")).out, /No plans waiting/);
  });

  it("when the team does not answer in time, says it may have arrived and that sending again is safe", async () => {
    await terminal.run("login");
    concern.timeOutNextSend = true;
    const run = await terminal.run("hire", "--verifier", "--type", "tests", "--task", "A test suite for the billing service", "--yes");
    assert.equal(run.code, EXIT.unsure);
    const plan = /concern send (\S+)/.exec(run.err)![1]!;
    const before = concern.sent.length;
    const again = await terminal.run("send", plan);
    assert.equal(again.code, EXIT.ok, again.err);
    assert.equal(concern.sent.length, before + 1);
    // Sending the same plan a third time is the same request: the server says so.
    const third = await terminal.run("send", plan);
    assert.equal(concern.sent.length, before + 1);
    assert.equal(third.code, EXIT.ok);
  });

  it("renews an access token that ran out, without the person seeing it", async () => {
    await terminal.run("login");
    concern.expireAccess();
    const grants = concern.tokenGrants.length;
    const run = await terminal.run("whoami");
    assert.equal(run.code, EXIT.ok, run.err);
    assert.deepEqual(concern.tokenGrants.slice(grants), ["refresh_token"]);
    // The new refresh token replaced the old one in the file: the next renewal works too.
    concern.expireAccess();
    assert.equal((await terminal.run("whoami")).code, EXIT.ok);
  });

  it("renews before calling when the clock says the token is about to run out", async () => {
    await terminal.run("login");
    const grants = concern.tokenGrants.length;
    terminal.now = () => Date.now() + 3600 * 1000;
    assert.equal((await terminal.run("requests")).code, EXIT.ok);
    assert.deepEqual(concern.tokenGrants.slice(grants), ["refresh_token"]);
  });

  it("forgets a sign-in that was disconnected on concern.pro, and says to sign in again", async () => {
    await terminal.run("login");
    concern.disconnect();
    const run = await terminal.run("requests");
    assert.equal(run.code, EXIT.signedOut);
    assert.match(run.err, /sign-in has ended/);
    // Nothing else was signed in, so the file is gone.
    assert.equal(existsSync(join(terminal.dir, "credentials.json")), false);
  });

  it("lists the workspace's requests, newest first", async () => {
    await terminal.run("login");
    await terminal.run("hire", "--engineer", "--type", "feature", "--task", "First: a countdown timer on the landing", "--yes");
    await terminal.run("hire", "--engineer", "--type", "feature", "--task", "Second: an add-to-cart flow", "--yes");
    const run = await terminal.run("requests");
    assert.equal(run.code, EXIT.ok, run.err);
    assert.ok(run.out.indexOf("Second") < run.out.indexOf("First"));
    assert.match(run.out, /from \$300 · open/);
  });

  it("answers as JSON for a script, and asks nothing", async () => {
    await terminal.run("login");
    terminal.interactive = true;
    const run = await terminal.run("hire", "--engineer", "--type", "integration", "--task", "Connect Stripe payments to our shop", "--yes", "--json");
    assert.equal(run.code, EXIT.ok, run.err);
    const answer = JSON.parse(run.out);
    assert.match(answer.sent, /^CR-/);
    assert.equal(answer.estimate.amount, 600);
    assert.deepEqual(terminal.asked, []);
  });

  it("takes the task from a file or from stdin", async () => {
    await terminal.run("login");
    terminal.files["brief.md"] = "# Release\nRun the regression suite before Friday's release.";
    assert.equal((await terminal.run("hire", "--verifier", "--type", "release", "--task-file", "brief.md", "--yes")).code, EXIT.ok);
    assert.equal(concern.sent.at(-1)!.args.task, "# Release\nRun the regression suite before Friday's release.");
    terminal.stdin = "A landing page for our spring campaign\n";
    assert.equal((await terminal.run("hire", "--engineer", "--type", "landing", "--task-file", "-", "--yes")).code, EXIT.ok);
    assert.equal(concern.sent.at(-1)!.args.task, "A landing page for our spring campaign");
  });

  it("signs out on this computer", async () => {
    await terminal.run("login");
    const run = await terminal.run("logout");
    assert.match(run.out, /account\/integrations/);
    assert.equal((await terminal.run("whoami")).code, EXIT.signedOut);
  });
});

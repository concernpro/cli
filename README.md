# concern

Hire [Concern](https://concern.pro)'s engineers and verifiers from your terminal. Describe
the work, see its starting price, and send it to Concern's team. They answer by email with
a quote, and nothing is charged or started before you approve it.

```bash
concern login
```

```bash
concern hire
```

```
What do you need done? Write it as the team should read it: what, where, by when. End with an empty line.
> Add Google sign-in to app.acme.test, next to the email form. By Friday.
>
Who should do it?
  1. Engineer (Enter) — Builds it: features, redesigns, integrations, landing pages.
  2. Verifier — Checks it: tests, reviews and release sign-off for code you already write.
...
  Engineer, Feature
  Estimate:  from $300 per task
  Speed:     Standard. Starts the next business day.
  Task:      Add Google sign-in to app.acme.test, next to the email form. By Friday.
  Plan:      zu3CuYvbcqFeRWCrfgCQPO5ef4a81fe0

Send this request to Concern's team? Nothing is charged before you approve a quote. [y/N] y
Sent. Reference DPL-F12956C8.
Concern's team will write to you@acme.test with a quote. Nothing is charged and nothing starts before you approve it.
```

## Install

It needs Node.js 20 or later.

```bash
npm install -g concern-cli
```

Until it is published, from a clone of this repository:

```bash
npm install && npm run build && npm link
```

## Commands

| Command | What it does |
| --- | --- |
| `concern login` | Opens concern.pro in your browser. You sign in there and approve the CLI for one workspace of your team |
| `concern hire [task]` | Asks what you need, prices it, and sends it to Concern's team once you say yes |
| `concern send [plan]` | Sends a plan made before. Without a plan it lists the plans that were not sent |
| `concern requests` | The workspace's latest requests, newest first, from everyone in the team |
| `concern pricing` | What can be hired and what it costs |
| `concern whoami` | Who is signed in, the team, the workspace and its connected task managers |
| `concern logout` | Forgets the sign-in on this computer |

Hiring is in two steps. First comes a **plan**: what is to be done, by whom, how soon, and
the estimate from Concern's own catalog. A plan sends nothing. The **request** goes once you
answer yes, or right away with `--yes`.

A request goes out under a reference made from the plan. If the answer gets lost, or
Concern's team does not confirm in time, `concern send <plan>` sends the same plan again.
Concern reads that as the same request and never as a second one.

## In scripts

Flags give everything the questions would ask. With all of them given, nothing is asked:

```bash
concern hire --engineer --type feature --task "Add a signup form to app.acme.test" --yes
```

```bash
concern hire --verifier --type review --task-file brief.md --priority --yes --json
```

```bash
concern hire --engineer --seats 2 --task "Two engineers on our checkout from Monday" --plan-only
```

- Who: `--engineer` or `--verifier`.
- One task: `--type` with `feature`, `landing`, `integration`, `redesign` or `custom-build`
  for an engineer; `review`, `tests`, `release` or `custom-verify` for a verifier.
- A subscription: `--seats <1–20>`, billed per seat per month.
- How soon: `--standard` (the default) or `--priority`.
- The work: `--task <text>`, or `--task-file <path>`, or `--task-file -` to read stdin.

`--json` prints the answer as JSON on stdout and asks nothing. The exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | It failed, and nothing was sent |
| 2 | The command was written wrong |
| 3 | Not signed in, or the sign-in has ended: run `concern login` |
| 4 | Sent, but Concern's team did not confirm in time. It may have arrived. Sending the same plan again is safe |

## How it works

The CLI is a client of concern.pro's MCP server, `https://concern.pro/mcp`, the same server
Claude connects to as a custom connector. It uses the same tools: `plan_deployment`,
`request_deployment`, `list_requests`, `get_workspace` and `get_pricing`. Every price,
every rule and every check is the server's, so the CLI has no prices of its own to fall
out of date.

Signing in is OAuth 2.1 with PKCE, the way Claude Code connects:

1. The CLI reads `/.well-known/oauth-protected-resource/mcp` and
   `/.well-known/oauth-authorization-server`, and refuses a site whose documents point
   anywhere but itself.
2. It registers as a public client that returns to `http://127.0.0.1/callback`. There is no
   secret to keep, and the port is chosen when the CLI starts.
3. Your browser opens the approval page on concern.pro. That page names the team and the
   workspace the CLI is let into. "Allow" sends the browser back to a one-off listener on
   127.0.0.1, which takes the answer only if it carries the state this sign-in sent.
4. The code is traded for an access token, good for an hour, and a refresh token, good for
   sixty days and replaced each time it is used. The CLI renews them on its own.

To use another workspace, switch to it in the dashboard and run `concern login` again.

The CLI keeps two files in `~/.config/concern` (`%APPDATA%\concern` on Windows, or
`$CONCERN_CONFIG_DIR`). `credentials.json` holds the tokens and is readable by you only.
`plans.json` holds the plans, so that one can be sent again. Both are kept per site
address, so a local copy of concern.pro never shares a sign-in with the real one.

`concern logout` forgets the tokens on this computer. concern.pro has no address where an
app can end its own approval, so the approval stays listed under Integrations in the
dashboard until it has gone unused for sixty days. Disconnect there ends it at once.

## Developing

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

`npm test` runs the whole CLI against `test/fake-concern.ts`, a stand-in for concern.pro
that follows its rules: discovery, registration, approval, tokens that run out and are
replaced, plans, and sending one plan twice. Node runs the TypeScript in `src/` as it is,
so `npm run concern -- <command>` runs the CLI without a build. `npm run build` writes
`dist/` for npm.

To work against a copy of concern.pro on your computer:

```bash
CONCERN_URL=http://localhost:3000 npm run concern -- login
```

## Not built yet

- Picking a particular person. Concern's team chooses who takes a request, and
  `concern whoami` lists who is deployed to the workspace once the team has written it.
- Paying. A request ends in a quote by email, as it does on concern.pro.
- Other languages. The CLI speaks English. Your task goes to the team in whatever language
  you write it in.

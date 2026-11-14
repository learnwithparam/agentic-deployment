# Parts: build notes for each part session

A part session builds one part from this file alone. Read the part's README (problem, diagram, step table),
then build each step the way Part 1 does: `step.toml`, `problem/` (README with the five sections, plus the
starter), `solution/`, at least one `wrong/<mistake>/`, and `checks/<step-name>.ts`. Each check must fail on
the starter and every wrong answer and pass on the solution (`bun run check` proves it). Remove
`TODO(part session)` from the part README once its Walkthrough has real commands, or `bun run check` will
still treat the part as a skeleton.

## Every part

| Part folder                                                               | Steps (minutes)                                                                                        | What each step's check reads                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-orientation/` (built)                                                 | `meet-the-council` (15)                                                                                | `findings.toml` against the register's rules (`world/register/rules.ts`) and the finished desk's trace for HDC-2026-0142 in the trace desk                                                                                                                                |
| `parts/01-ship-the-desk/` (built)                                         | `package-the-agent` (20), `move-secrets-out` (15), `sign-in-staff` (20)                                | container health and user (`docker inspect`), the SSE stream of 3 replay runs, register decisions and letters; every image layer via `docker save`, the container env, the gateway spend log; the redirect to sign-in, the answers to five callers, the register's status |
| `parts/02-see-every-run/`                                                 | `trace-every-run` (20), `price-each-run` (15)                                                          | `GET http://localhost:7004/api/spans` (same data as `out/spans.jsonl`) after 5 replayed applications; `GET /admin/spend` on the gateway, matched by `run_id`                                                                                                              |
| `parts/03-bound-the-runs/`                                                | `cap-the-spend` (20), `rate-limit-residents` (10), `survive-a-restart` (20)                            | the spend log and the done event for HDC-2026-0177; status codes and `Retry-After` for two residents; register audit and letters plus spend log rows per run after `bun run chaos kill --desk`                                                                            |
| `parts/04-release-safely/`                                                | `gate-with-evals` (20), `ship-a-canary` (20), `roll-back-automatically` (20), `write-the-runbook` (15) | the gate's exit code and printed ids; `release.id` on spans across 200 runs; Prometheus `/api/v1/alerts`, the release controller's `/state` audit; `runbook.md` headings and the gateway's `/health` `killed` flag                                                        |
| `parts/05-go-further/` (stretch)                                          | `shadow-the-canary` (25), `deploy-to-the-cloud` (30), `sign-in-with-keycloak` (30)                     | shadow spans and zero register writes from the shadow; the stream checks against a public URL; a Keycloak realm's discovery document, tokens checked with `jose`, and a narrowed token from token exchange                                                                |
| `parts/06-deploy-the-agent-to-cloud-run-with-floci-gcp/` (closing, built) | `release-on-cloud-run` (30)                                                                            | the folder's own `docker-compose.yml` and `release.ts`, run against floci-gcp 0.12.0: the secret in Secret Manager, revisions desk-00001 to desk-00003 and the release each serves through the Cloud Run Admin API v2                                                     |

Minutes are already in `schedules.toml`. If a step changes length, change the schedule sessions too.

## What the spine gives you

**The world** (`world/`, started by `bun run world`, reset by `bun run world reset`):

- Register :7001: `GET /applications`, `GET /applications/:id` (no email or phone), `.../checklist?page=N`,
  `.../fee`, `POST .../decision` (honours `Idempotency-Key`, refuses a second decision with 409),
  `POST .../letters` (deduplicates on `Idempotency-Key`), `POST .../validate`, `GET /letters`, `GET /audit`,
  `GET /expected?application_id=` (the rules' answer), `GET /metrics` (`register_decisions_total{release,agrees}`),
  `POST /admin/reset`, `POST /admin/reopen {ids}` (keeps the counters), `POST /admin/chaos {hold_letters_ms}`.
- Gateway :7002: OpenAI chat format, `model` is a role. Keys `desk` ($2 budget) and `finished` ($50).
  `GET /admin/spend` (rows with `key`, `role`, `run_id`, tokens, `cost_usd`), `POST /admin/budget`,
  `POST /admin/kill` and `/admin/revive` (the kill switch for the runbook step), `POST /admin/reset`.
  A spent budget answers 429 `budget_exceeded`.
- Sign-in :7003: OIDC with `authorization_code`, `client_credentials` (role `agent`) and `password` grants.
- Trace desk :7004: OTLP over HTTP as JSON at `/v1/traces`; `GET /api/traces`, `GET /api/spans`,
  `POST /api/reset`. Protobuf gets a 415 with a plain message.
- Planted faults: HDC-2026-0177 (endless checklist pages), `world/releases/v2.json` (a missing fee is fine),
  `bun run chaos kill` (holds the letter, kills the desk after the decision).

**The finished desk** (`world/finished/`, `bun run up finished`) already does every part. Borrow from it:
`desk/src/telemetry.ts` (OpenTelemetry), `desk/src/agent.ts` (brakes, journal, spans), `desk/src/runs.ts`
(the journal), `desk/src/server.ts` (rate limit, `/v1/runs/:id`, `/metrics`), `controller/server.ts`
(Traefik weights and the rollback webhook), `prometheus/alerts.yml`, `alertmanager/alertmanager.yml`.

**The checker library** (`checks/lib/`, Bun built-ins only, because CI runs `bun run check` without
`bun install`):

- `world.ts`: `world()`, `resetWorld()`, `replayMode()`, `application()`, `letters()`, `audit()`,
  `spend()`, `spans()`, `setStatus()`, `tokenFor(username)`, `serviceToken()`, `forgedToken()`.
- `desk.ts`: `startDesk(dir)` (Compose project `hdc-desk`, port 3000, once per check run per folder),
  `deskService()`, `composeConfig()`, `container()`, `exec()`, `image()`.
- `sse.ts`: `postRun(id, base?, headers?)` with each event and its arrival time.
- `image.ts`: `findInImage(image, needles)` over every layer, the config and the history.
- `finished.ts`: `finished()` and `traceOf(applicationId)`.

Each later step's `problem/` starts from the previous step's `solution/`. Part 2's first starter is
`parts/01-ship-the-desk/03-sign-in-staff/solution/`.

## Things the spine learned that save you time

- OpenTelemetry JS 3.x (`@opentelemetry/sdk-trace` 3.1.1) takes `new BatchSpanProcessor({ exporter })`, an
  options object. Passing the exporter directly fails with `this._exporter` undefined. Use
  `@opentelemetry/context-async-hooks` for context on Bun; `StackContextManager` loses it across `await`.
- AI SDK 7 refuses system messages in `messages`; pass them as `instructions` (see
  `world/gateway/providers.ts`).
- Prometheus counters vanish on a world reset. The alert in `world/finished/prometheus/alerts.yml` uses
  totals, and the release controller acts on repeated notifications (`repeat_interval: 10s`), so a stale
  alert cannot roll back a new canary once Prometheus has seen the reset.
- The replay model writes `missing_items` with the register's item names plus `fee`, so the register's
  agreement check compares status and missing items. Release v2 disagrees whenever a fee is owed.
- Replay cost of HDC-2026-0142 on v1 is $0.014128. If you change `world/releases/v1.json`, the tools or
  the replay script, update `00-orientation/meet-the-council/solution/findings.toml` and the Expect lines.

## Sources and numbers

Only numbers read on the company's own page on the build date reach learner files. The research brief's
numbers marked "(search)" were dropped: their pages were not reachable from the build session (The Register,
OpenAI, GOV.UK, The Markup, Seattle, Allianz, C.H. Robinson, Kaiser Permanente, Sysdig and others). A part
session that can open one of those pages may add its number with the citation. The pages that were read:

- https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues (16% of Sonnet 4 requests at
  the worst impacted hour; about 30% of Claude Code users with at least one misrouted message; rolled back;
  continuous quality evaluations on production)
- https://www.anthropic.com/engineering/built-multi-agent-research-system (agents about 4 times the tokens of
  chat, multi-agent about 15 times; resume from where the agent was; gradual traffic shifts between versions)
- https://www.anthropic.com/engineering/claude-code-sandboxing (credentials never inside the sandbox;
  sandboxing cut permission prompts by 84%)
- https://platform.claude.com/docs/en/about-claude/pricing (prices in `config/models.ts`)

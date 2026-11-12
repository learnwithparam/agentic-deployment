# The world: Harrowby District Council permit desk

Harrowby is a fictional English district council. Residents apply for permits: a house extension, a cafe in
an old shop, a shop sign, work on a tree, a dropped kerb. Before a planning officer judges an application on
its merits, someone must check that it is complete: the form, the plans, the certificates and the fee. That
check is called validation, and it is the agent's job.

The council's word is public. A letter that tells a resident "no fee is needed" when a fee is due is the
council's mistake, paid for by taxpayers.

## What runs

| Service    | URL                   | What it does                                                                                                                                                                 |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register   | http://localhost:7001 | The system of record. Holds every application, its status, every letter and an audit log.                                                                                    |
| Gateway    | http://localhost:7002 | The only thing that holds a model key. Gives each service its own gateway key with a dollar budget, prices every call and writes a spend log. Speaks the OpenAI chat format. |
| Sign-in    | http://localhost:7003 | An OpenID Connect provider with the council's staff and residents. Tokens carry a `roles` claim.                                                                             |
| Trace desk | http://localhost:7004 | Takes OpenTelemetry spans (OTLP over HTTP, JSON), writes them to `out/spans.jsonl` and shows a waterfall.                                                                    |

```bash
bun run world
```

Expect: `The world is running. Model provider: replay.` and four lines with the URLs above.

## Its data

- `data/applications/`: 40 applications, `HDC-2026-0140` to `HDC-2026-0179`. About half miss an item or part
  of the fee, as on a real desk.
- `data/checklist.json`: the council's validation list. For each kind of application: the items it needs and
  the fee.
- `data/people.json`: who can sign in and their roles (`validation_officer`, `team_lead`, `budget_holder`,
  `resident`). Passwords are made fresh by `bun run world` and saved in `secrets/passwords`.

## The register's rules

- A status is one of `received`, `invalid_missing_items`, `valid_awaiting_officer`, `validated`.
- The agent may write only `invalid_missing_items` or `valid_awaiting_officer`, and only once per
  application. A second write with the same `Idempotency-Key` header returns the first answer.
- Only an officer's action writes `validated`.
- Letters are kept per application. A letter sent twice with the same `Idempotency-Key` is stored once.
- The register judges every decision with the council's rules (`register/rules.ts`) and counts, per release,
  whether the agent agreed. Prometheus can read the counts at `/metrics`.

## Planted faults

| Fault                   | Where                | What it does to a naive agent                                                                                           |
| ----------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The runaway application | `HDC-2026-0177`      | Its attachment list "continues on the next page" forever. An agent with no step limit keeps reading pages and spending. |
| The bad prompt          | `releases/v2.json`   | A new prompt that tells the agent "a missing fee is fine". It passes a quick look and writes wrong letters.             |
| The held letter         | `bun run chaos kill` | Holds the letter call open, then stops the desk between the register write and the letter.                              |

## Models

The gateway asks `config/models.ts` which model plays each role. With `LLM_PROVIDER=replay` (the default) it
plays back the permit desk's script: no key, no network, the same answer every time. To use a real model, copy
`.env.example` to `.env`, set `LLM_PROVIDER` and one key, then run `bun run world stop` and `bun run world`.

## Reset

```bash
bun run world reset
```

Expect: `The world is reset: 40 applications received, no letters, no spend, no spans.`

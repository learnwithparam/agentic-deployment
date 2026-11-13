# The world: Harrowby District Council permit desk

Harrowby is a district council in England. It is not real. Residents apply to it for permits. For example,
one resident wants a house extension. Another wants to open a cafe in an old shop. Others ask for a shop sign,
work on a tree, or a lower kerb in front of a driveway.

A planning officer judges each application on its merits. But first, someone must check that it is
complete: the form, the plans, the certificates and the fee. This check is called validation. It is the
agent's job.

The council's word is public. Suppose a letter tells a resident "no fee is needed", but a fee is due. That is
the council's mistake, and taxpayers pay for it.

## What runs

| Service    | URL                   | What it does                                                                                                                                                                 |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register   | http://localhost:7001 | The council's official record. It holds every application, its status, every letter and an audit log.                                                                        |
| Gateway    | http://localhost:7002 | The only service that holds a model key. It gives each service its own key with a dollar budget, prices every call and writes a spend log. It speaks the OpenAI chat format. |
| Sign-in    | http://localhost:7003 | An OpenID Connect provider with the council's staff and residents. Its tokens carry a `roles` claim.                                                                         |
| Trace desk | http://localhost:7004 | It takes OpenTelemetry spans (OTLP over HTTP, as JSON), writes them to `out/spans.jsonl` and shows them as a waterfall.                                                      |

```bash
bun run world
```

Expect: `The world is running. Model provider: replay.` and four lines with the URLs above.

You can ask what is running at any time. This command starts nothing:

```bash
bun run world status
```

Expect: the same lines, and how many applications have each status, for example `40 applications: 40 received`.

## Its data

- `data/applications/` holds 40 applications, from `HDC-2026-0140` to `HDC-2026-0179`. About half of them
  miss an item or part of the fee, as on a real desk.
- `data/checklist.json` is the council's validation list. For each kind of application, it lists the items
  the application needs, and the fee.
- `data/people.json` lists who can sign in, and their roles. The roles are `validation_officer`,
  `team_lead`, `budget_holder` and `resident`. `bun run world` makes new passwords and saves them in
  `secrets/passwords`.

For example, HDC-2026-0150 is a `householder` application for a two storey side extension. The checklist
says a `householder` application costs 258 pounds. The resident paid 129 pounds, so 129 pounds are still
missing.

## The register's rules

- A status is one of `received`, `invalid_missing_items`, `valid_awaiting_officer` or `validated`.
- The agent may write only `invalid_missing_items` or `valid_awaiting_officer`. It may write only once per
  application. If a second write has the same `Idempotency-Key` header, the register returns the first answer.
- Only an officer's action writes `validated`.
- The register keeps letters per application. If a letter is sent twice with the same `Idempotency-Key`, the
  register stores it once.
- The register judges every decision with the council's rules (`register/rules.ts`). For each release, it
  counts whether the agent agreed with the rules. Prometheus reads the counts at `/metrics`.

An idempotency key is a unique name for one write. If the same write arrives again with the same key, the
register does not do it twice.

## Planted faults

These faults are put in the world on purpose, so that you can see what goes wrong.

| Fault                   | Where                | What it does to an agent with no protection                                                                            |
| ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The runaway application | `HDC-2026-0177`      | Its list of attachments "continues on the next page", forever. An agent with no step limit keeps reading and spending. |
| The bad prompt          | `releases/v2.json`   | A new prompt that tells the agent "a missing fee is fine". It looks fine at first sight, and it writes wrong letters.  |
| The held letter         | `bun run chaos kill` | It holds the letter call open. Then it stops the desk after the register write and before the letter.                  |

## Models

The gateway asks `config/models.ts` which model plays each role. The default is `LLM_PROVIDER=replay`. Replay
plays back the permit desk's recorded script. It needs no key and no network, and it gives the same answer
every time.

To use a real model:

1. Copy `.env.example` to `.env`.
2. Set `LLM_PROVIDER` and one key.
3. Run `bun run world stop`, then `bun run world`.

## Reset

```bash
bun run world reset
```

Expect: `The world is reset: 40 applications received, no letters, no spend, no spans.`

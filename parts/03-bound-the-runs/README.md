# Part 3: Bound the runs

## After this part you can

Stop a runaway run with a step limit and a dollar limit. Limit how many runs one person starts. Resume a killed run without a second letter. Fall back to another provider when one stalls. Keep waits short with a queue.

## You leave with

A desk with brakes and a memory, and a note in `out/bad-night.md` that says which brake fired first on a bad night.

## The problem

Application HDC-2026-0177 has a list of attachments that "continues on the next page", forever. The desk keeps reading pages, and every page costs a paid model call. A resident who reloads twenty times starts twenty runs. And when the desk's container is killed after a decision but before the letter, a retry can send two letters, or none. Anthropic reports that agents use about 4 times more tokens than chat, so loops like these cost real money fast.

```mermaid
flowchart TD
  A[run starts] --> L{step limit or dollar limit reached?}
  L -->|yes| S[stopped_budget, clean error to the resident]
  L -->|no| G[gateway call]
  G -->|429 budget_exceeded| S
  G --> T[tool call with an idempotency key]
  T --> J[(journal: step saved)]
  J --> A
  K[container killed] -.->|restart| J
```

## Why it matters

Systems with many agents use about 15 times more tokens than chat. When an error happens, Anthropic does not restart a long run from the beginning. A restart costs a lot, and it annoys users. So Anthropic built systems that resume from where the agent was.

A brake is a limit that stops a run. A run journal saves each finished step, so a restarted run goes on from where it stopped. An alert tells you about spending after it happened. A limit refuses the next call before it happens.

For example, the finished desk has a step limit of 12 in its `release.json` (`"max_steps": 12`). Run `bun run chaos runaway` against it, and it prints this:

```text
The run ended: stopped_budget after 12 model calls, $0.0345
```

The resident sees a short message that begins "This check stopped after". The status `stopped_budget` means a limit stopped the run. Nobody waits forever.

## Steps

| Step                               | You make                                                                        | The check reads                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cap-the-spend`                    | a step limit and a dollar limit per run, and a budget on the desk's gateway key | `bun run chaos runaway`: the run ends `stopped_budget` in under 25 steps and under $0.10 (spend log); a budget refusal from the gateway reaches the resident as `event: error`        |
| `rate-limit-residents`             | a limit per resident (header `x-resident-id`, else address)                     | 6 requests from one resident inside the window get one 429 with `Retry-After`; another resident still gets 200                                                                        |
| `survive-a-restart`                | a run journal and idempotency keys on the register writes                       | `bun run chaos kill --desk`: after the restart the run finishes, the register holds one decision and one letter, and no completed model step is called again (spend log rows per run) |
| `fall-back-when-a-provider-stalls` | a timeout on each provider call and a fallback to the next provider             | four in-process rules against fake providers: a stall or a 500 moves on, and no spare is asked when the first answers                                                                 |
| `hold-the-latency-goal`            | a queue with a limit on runs going, a limit on runs waiting and a longest wait  | six in-process rules: order, limits, `too_busy` with a retry time, and a freed slot after an error                                                                                    |

## Watch and read

| Kind  | Title                                                       | Made by                                  | Why                                                                           | Link                                                                      |
| ----- | ----------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| read  | How we built our multi-agent research system                | Anthropic Engineering                    | Shows why agents cost so much and why a long run must resume, not restart.    | <https://www.anthropic.com/engineering/built-multi-agent-research-system> |
| video | SE Radio 596: Maxim Fateev on Durable Execution             | Maxim Fateev, who co-created Temporal    | The maker of a durable run engine explains saving each step and resuming.     | <https://www.youtube.com/watch?v=fMh2ZYJST0E>                             |
| video | Temporal: Open Source Durable Workflows for Apps and Agents | The Temporal team                        | A short tour of runs that survive a crash, with agents as the example.        | <https://www.youtube.com/watch?v=oUZd8tWr6zw>                             |
| read  | Handling Overload                                           | Google Site Reliability Engineering team | Explains refusing work early, which is the idea behind your queue and limits. | <https://sre.google/sre-book/handling-overload/>                          |
| read  | Designing robust and predictable APIs with idempotency      | Brandur Leach at Stripe                  | The clearest write-up of idempotency keys, which stop a second letter.        | <https://stripe.com/blog/idempotency>                                     |

## Walkthrough

Work in each step's `problem/` folder. Start the world first.

```bash
bun run world
```

Expect: `The world is running. Model provider: replay.`

Step 1: add the step limit and the dollar limit, and turn the gateway's refusal into a clean stop.

```bash
bun run up cap-the-spend
bun run chaos runaway --desk
bun run verify cap-the-spend
```

Expect: `The run ended: stopped_budget after 12 model calls, $0.0345`, then `Done. All 5 rules pass.`

Step 2: give each resident a limit of 5 runs in 10 seconds.

```bash
bun run up rate-limit-residents
bun run verify rate-limit-residents
```

Expect: `Done. All 4 rules pass.` once the 6th quick request gets 429 with `Retry-After`.

Step 3: keep a run journal, so a killed run finishes after the restart.

```bash
bun run up survive-a-restart
bun run chaos kill --desk
bun run verify survive-a-restart
```

Expect: `Register: 1 decision(s) and 1 letter(s) for HDC-2026-0142.`, then `Done. All 3 rules pass.`
The starter prints the register line too, so trust the check, not that line.

Step 4: give each provider call a timeout and a fallback. You do not need Docker for this step.

```bash
bun run verify fall-back-when-a-provider-stalls
```

Expect: `Done. All 4 rules pass.`

Step 5: add a queue with a limit on runs going and on runs waiting. You do not need Docker for this step.

```bash
bun run verify hold-the-latency-goal
```

Expect: `Done. All 6 rules pass.`

Check the whole part:

```bash
bun run verify part bound-the-runs
```

Expect: `Part bound-the-runs is done: 5/5 steps pass.`

```
Part bound-the-runs:
  PASS   cap-the-spend  (5/5 rules)
  PASS   rate-limit-residents  (4/4 rules)
  PASS   survive-a-restart  (3/3 rules)
  PASS   fall-back-when-a-provider-stalls  (4/4 rules)
  PASS   hold-the-latency-goal  (6/6 rules)
Part bound-the-runs is done: 5/5 steps pass.
```

## Project

Add one brake to one real piece of your own work. Pick a loop or a job in your project that calls a paid service. Give it a limit on calls or on money, and make it stop with a clear message. Then kill it once in the middle and check that a restart does not repeat a paid step.

## Assignment: survive the bad night

Picture a bad night at the council. A runaway application loops, and the desk's container is killed
in the middle of a run. In the morning there must be no overspend and no second letter.

For example, after `bun run chaos runaway --desk` and `bun run chaos kill --desk`, the spend log shows
one run stopped at 12 model calls and $0.0345. The register shows 1 decision and 1 letter for
HDC-2026-0142.

1. Run both chaos commands against your desk from `survive-a-restart`.
2. Write `out/bad-night.md`. Say which brake fired first for HDC-2026-0177: the step limit, the dollar
   limit or the key's budget. Say why you chose that order of limits.
3. In the same note, name the idempotency key for the letter and what it is built from.

Hand in your branch and `out/bad-night.md`. It is graded yes or no on each question:

- Do `bun run verify cap-the-spend`, `rate-limit-residents` and `survive-a-restart` pass?
- Did the runaway run end as `stopped_budget`?
- Is there exactly one letter for the killed application?
- Does the note name the idempotency key and what it is built from?

Extension: kill the desk at 10 different points in a run, not only before the letter. Show zero
duplicate letters in all 10.

## Finished

Your desk now has brakes and a memory:

- A runaway run stops itself at the step limit or the dollar limit, and the resident reads why.
- A spent gateway budget ends a run cleanly as `stopped_budget`, never as a hang.
- One resident cannot start more than 5 runs in 10 seconds, and every other resident is still served.
- Every run is saved after each step, so a killed run finishes after the restart with no second letter
  and no model call paid twice.
- A provider that stalls is given up on, and the next one answers.
- A rush of runs waits in a short line, and the extra ones are told to try again.

Next is Part 4, release safely. You change the desk's prompt without hurting residents. A gate of
evals runs before each release. A canary gets a small share of traffic. A bad canary rolls back by
itself, and a runbook tells the people on call what to do.

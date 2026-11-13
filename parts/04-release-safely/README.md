# Part 4: Release safely

## The problem

The planning team wants a friendlier prompt. Release v2 reads well, and at first sight its letters look fine.
But its prompt tells the agent "a missing fee is fine". The council's word is public, so a wrong letter is a
real problem.

For example, take HDC-2026-0142. The resident has paid nothing of a £578 fee. Release v1 writes
`invalid_missing_items` and asks for "The application fee of £578". Release v2 writes
`valid_awaiting_officer` instead. Its letter says "It has everything we need, and no fee is needed."

Today a new prompt goes to every resident at once. The only way back is that someone notices the problem and
deploys the old version again by hand.

In this part you add four safety steps:

- An eval is a test of the agent's answers on fixed cases. A gate runs the evals and blocks a release that
  fails them.
- A canary sends a new release to a small share of residents first, here 10%.
- An automatic rollback sets the canary to 0% when an alert fires.
- A runbook is a page of steps that a person follows when something goes wrong.

## Why it matters

A change to load balancing once sent some Claude requests to the wrong servers. At the worst point, 16% of
Sonnet 4 requests were affected. Anthropic rolled back the faulty changes. Now it runs quality tests all the
time on its real production systems
([Anthropic Engineering, "A postmortem of three recent issues"](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)).

Anthropic also ships agent updates slowly, step by step. Old and new versions run side by side for a while
([Anthropic Engineering, "How we built our multi-agent research system"](https://www.anthropic.com/engineering/built-multi-agent-research-system)).

```mermaid
flowchart LR
  G[bun run gate v2] -->|fails: exit 1| X[release blocked]
  G -->|passes| CAN[canary 10%]
  T[Traefik] -->|90%| S[stable v1]
  T -->|10%| CAN
  S & CAN --> REG[(Register judges every decision)]
  REG --> P[Prometheus] --> AM[Alertmanager] -->|webhook| RC[Release controller]
  RC -->|weight 0| T
```

## Steps

| Step                      | Minutes | You make                                                                                                         | The check reads                                                                                                                                         |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate-with-evals`         | 20      | `bun run gate <release>`: 30 fixed applications, code checks first (status, missing items, fee wording)          | exit code and printed case ids: passes `v1`, fails `v2`                                                                                                 |
| `ship-a-canary`           | 20      | a Traefik weighted service (stable and canary) and `release.json` as one release unit whose id is on every span  | 200 replayed requests: 80 to 100 percent served by stable, read from spans by `release.id`                                                              |
| `roll-back-automatically` | 20      | a Prometheus alert on decisions the register disagrees with, and an Alertmanager route to the release controller | `bun run chaos bad-canary`: within 3 minutes and no key pressed, canary weight is 0, the alert fired, and the rollback is in the controller's audit log |
| `write-the-runbook`       | 15      | `runbook.md`: Symptoms, First five minutes, Kill switch, Roll back, Who to tell, After                           | every alert's `runbook_url` points to a heading; the kill switch command stops all model calls in under 10 seconds (gateway health); no empty section   |

## Walkthrough

TODO(part session): the commands for each step, each with its Expect line.

```bash
bun run verify part release-safely
```

Expect: `Part release-safely is done: 4/4 steps pass.`

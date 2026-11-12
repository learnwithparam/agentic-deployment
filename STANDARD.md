# The workshop standard

Every learnwithparam course repo starts from this template and follows these rules. Each rule is a check:
`bun run check` runs them all, CI runs it on every push, and a rule with no check does not count.
The research behind each rule is in the curriculum repo under `workshop-standard/research/`.

## Shape

```
README.md                run the finished system first, then how the course works
00-orientation/          setup, meet the world, see the goal; troubleshooting.md
world/                   the business: its data, its system of record, its app
parts/NN-<verb-thing>/   README.md: the problem, its cost, a Mermaid diagram
  NN-<verb-thing>/       one step: one problem, one outcome, one check
    step.toml            minutes, screen
    problem/             README.md and the starter; the learner works here
    solution/            the sample answer; CI proves the check passes on it
    wrong/<mistake>/     at least one common mistake; CI proves the check rejects it
    images/expected.png  the expected result, for any step with something on screen
checks/<step-name>.ts    the rules for one step
config/models.ts         the only file that names a model
schedules.toml           parts mapped onto formats
```

## Rules and the check behind each

| Rule                                                                                                                 | Check             | Learned from                                         |
| -------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| No Makefile. Commands are Bun or `uv run` scripts.                                                                   | `check.ts` 1      | user, 12 Nov 2026                                    |
| A step is named verb-thing and the learner types that name: `bun run verify <step-name>`. Never a number.            | `check.ts` 2, 3   | epicshop issue #184, numbered steps break on reorder |
| Plain English: no em dash, no hype word, no week, day or hour in content.                                            | `check.ts` 2      | RESEARCH.md                                          |
| Every part README has a Mermaid diagram and a Walkthrough section with its commands.                                 | `check.ts` 3      | RESEARCH.md, user 12 Nov 2026                        |
| The root README shows the finished system as a screenshot and a Mermaid diagram; the orientation shows a screenshot. | `check.ts` 2b     | user 12 Nov 2026                                     |
| Every step shows a picture: a screenshot or a Mermaid diagram.                                                       | `check.ts` 3      | user 12 Nov 2026                                     |
| Every image a page names exists.                                                                                     | `check.ts` 2b     | user 12 Nov 2026                                     |
| Every step README has: The problem, Your challenge, Done when, If you get stuck, Words you will use.                 | `check.ts` 3      | epicshop, Carpentries                                |
| A step takes 5 to 30 minutes and its README stays under 600 words. Split, never squeeze.                             | `check.ts` 3      | epicshop step sizes                                  |
| A step whose result is on screen ships `images/expected.png` and shows it.                                           | `check.ts` 3      | Langfuse workshop learner docs                       |
| The check fails on the starter, fails on every wrong answer, and passes on the solution.                             | `verify.ts --all` | Rustlings, freeCodeCamp #70626 and #67904            |
| Every failing rule prints a try-next sentence.                                                                       | `verify.ts --all` | Exercism, mcp-fundamentals                           |
| Pass, fail and error exit 0, 1 and 2. Progress is recomputed from the checks every run.                              | `verify.ts`       | GitHub Skills stuck learners, Oct 2026               |
| `bun run verify --report` writes `verify-report.json` for cohort grading.                                            | `verify.ts`       | Exercism results.json, GitHub Classroom              |
| The README runs the finished system before any concept section.                                                      | `check.ts` 4      | Decoding AI courses, llm-twin #25                    |
| Every bash block is followed by an `Expect:` line.                                                                   | `check.ts` 4      | live-labs walkthrough                                |
| Model ids live only in `config/models`. Versions are pinned exactly.                                                 | `check.ts` 5      | anthropics/courses #71, philoagents #43              |
| Every failure message a learner can see is in `00-orientation/troubleshooting.md`.                                   | `check.ts` 5      | Langfuse workshop #30, philoagents #31               |
| Every schedule covers every part, and its minutes add up.                                                            | `check.ts` 6      | RESEARCH.md                                          |

## Readable code

Learners read our code before they write their own, so every file reads like plain English, in every
language. `bun run readable` checks it, and `bun run check` runs it first.

- **Names are whole words** that say what the thing holds or does: `invoice`, `overdueInvoices`,
  `sendReminder`. Never `d`, `r`, `x`, `ctx`, `res`, `fn` or `msg`. Only `i`, `j`, `id`, `ok`, `db`,
  `fs`, `os`, `io` and `ui` may be short.
- **One idea per line.** A chain of more than three calls becomes named steps. Never a ternary inside a
  ternary; use `if` and `else`.
- **Short and flat.** A function does one job in 40 lines or fewer, takes at most 4 inputs, and stays
  shallow (cognitive complexity 10 or less).
- **Lines are 100 characters or fewer**, formatted by the language's own tool, never by hand: Biome for
  TypeScript and JavaScript (`bun run format`), ruff for Python (`uvx ruff format`), and `terraform fmt`,
  `gofmt` or `shfmt` for those languages.
- **A comment says why**, in a plain sentence. The code already says what.

```typescript
// Hard to read
const due = (d: Inv[]) => d.filter((x) => x.s === "open" && x.dt < now()).map((x) => x.id);

// Reads like English
function overdueInvoiceIds(invoices: Invoice[]): string[] {
  const today = new Date();
  const overdue = invoices.filter(
    (invoice) => invoice.status === "open" && invoice.dueDate < today,
  );
  return overdue.map((invoice) => invoice.id);
}
```

## Plain English

Learners read every page in their second or third language. So each page uses short sentences, everyday words and a real example.

- One idea per sentence, 25 words at most.
- Everyday words: "use", not "utilize". "For example", not "e.g.".
- Every teaching page (the root README, each part README, each step's problem README) shows one case with "For example".
- Reading grade 8 or lower. A course for people who do not code sets `"plainEnglish": { "grade": 6 }` in package.json.

Hard to read:

> Utilize the verifier subsequent to modifying the configuration in order to ascertain correctness.

Easy to read:

> Change the config. Then run `bun run verify`. For example, after you add a rule, the check tells you if it passes.

## Checks test behaviour

A check runs the learner's command or calls their endpoint and judges the answer. It never imports their
functions, so any language or framework passes. Open-ended courses publish a small CLI or HTTP contract and
check scenarios against it.

## Run it

```bash
bun run check
```

Expect: `The repo meets the standard` and `Every check rejects its starter and wrong answers, and passes its solution.`

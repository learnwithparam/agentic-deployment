// biome-ignore-all lint/style/useNamingConvention: findings.toml keys stay snake_case
// meet-the-council: the learner ran the finished desk and read the register and the trace
// correctly.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { finished, traceOf } from "./lib/finished";
import { applications, expected, type Span } from "./lib/world";

const APP = "HDC-2026-0142";

/** What the learner wrote in findings.toml. Any key may be missing or the wrong type. */
type Findings = {
  status?: unknown;
  missing?: unknown;
  fee_owed_gbp?: unknown;
  run_cost_usd?: unknown;
  tool_calls?: unknown;
};

function truth() {
  const application = applications().find((candidate) => candidate.id === APP);
  if (!application) throw new Error(`${APP} is not in the register's data`);
  return expected(application);
}

function findings(dir: string): Findings {
  const file = join(dir, "findings.toml");
  if (!existsSync(file)) return {};
  return Bun.TOML.parse(readFileSync(file, "utf8")) as Findings;
}

const rootSpan = (spans: Span[]) => spans.find((span) => !span.parent_span_id);

async function runCost(): Promise<unknown> {
  const root = rootSpan(await traceOf(APP));
  return root?.attributes["app.cost_usd"];
}

function missingMatches(dir: string): boolean {
  const written = findings(dir).missing ?? [];
  const wanted = truth().missing;
  return (
    Array.isArray(written) &&
    written.length === wanted.length &&
    wanted.every((item) => written.includes(item))
  );
}

export default [
  {
    says: "status is the one the register holds for HDC-2026-0142",
    test: (dir) => findings(dir).status === truth().status,
    tryNext: "Open http://localhost:7001 and read the Status column for HDC-2026-0142.",
  },
  {
    says: "missing lists what the letter asks for, by the register's names",
    test: missingMatches,
    tryNext:
      "Read the letter at http://localhost:7001/letters?application_id=HDC-2026-0142" +
      " and the audit's missing_items.",
  },
  {
    says: "fee_owed_gbp is what the checklist says is still owed",
    test: (dir) => Number(findings(dir).fee_owed_gbp) === truth().fee_owed_gbp,
    tryNext:
      "Compare the fee in world/data/checklist.json for a change of use" +
      " with fee_paid_gbp in the application.",
  },
  {
    says: "the finished desk runs on this machine and HDC-2026-0142 has a trace with a cost",
    test: async () => (await finished()) && Boolean(await runCost()),
    tryNext: "Start it with bun run up finished, then bun run run-application HDC-2026-0142.",
  },
  {
    says: "run_cost_usd matches the cost on the run's root span",
    test: async (dir) => {
      const cost = Number(await runCost());
      const written = Number(findings(dir).run_cost_usd);
      return Number.isFinite(cost) && Math.abs(written - cost) < 0.0001;
    },
    tryNext:
      "Open http://localhost:7004, pick the HDC-2026-0142 trace," +
      " and copy app.cost_usd (4 decimal places is enough).",
  },
  {
    says: "tool_calls matches the execute_tool spans in that trace",
    test: async (dir) => {
      const written = Number(findings(dir).tool_calls);
      const trace = await traceOf(APP);
      const toolSpans = trace.filter((span) => span.name.startsWith("execute_tool"));
      return written === toolSpans.length;
    },
    tryNext:
      "Count the amber bars in the waterfall: each is one execute_tool span." +
      " The green ones are model calls.",
  },
] satisfies Rule[];

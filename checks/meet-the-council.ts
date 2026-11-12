// meet-the-council: the learner ran the finished desk and read the register and the trace correctly.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { finished, traceOf } from "./lib/finished";
import { applications, expected } from "./lib/world";

const APP = "HDC-2026-0142";
const truth = () => expected(applications().find((a) => a.id === APP)!);
const findings = (dir: string): any => {
  const f = join(dir, "findings.toml");
  return existsSync(f) ? Bun.TOML.parse(readFileSync(f, "utf8")) : {};
};
const root = (spans: any[]) => spans.find((s) => !s.parent_span_id);

export default [
  {
    says: "status is the one the register holds for HDC-2026-0142",
    test: (dir) => findings(dir).status === truth().status,
    tryNext: "Open http://localhost:7001 and read the Status column for HDC-2026-0142.",
  },
  {
    says: "missing lists what the letter asks for, by the register's names",
    test: (dir) => {
      const m = findings(dir).missing ?? [];
      const t = truth().missing;
      return Array.isArray(m) && m.length === t.length && t.every((x) => m.includes(x));
    },
    tryNext:
      "Read the letter at http://localhost:7001/letters?application_id=HDC-2026-0142 and the audit's missing_items.",
  },
  {
    says: "fee_owed_gbp is what the checklist says is still owed",
    test: (dir) => Number(findings(dir).fee_owed_gbp) === truth().fee_owed_gbp,
    tryNext:
      "Compare the fee in world/data/checklist.json for a change of use with fee_paid_gbp in the application.",
  },
  {
    says: "the finished desk runs on this machine and HDC-2026-0142 has a trace with a cost",
    test: async () =>
      (await finished()) && Boolean(root(await traceOf(APP))?.attributes["app.cost_usd"]),
    tryNext: "Start it with bun run up finished, then bun run run-application HDC-2026-0142.",
  },
  {
    says: "run_cost_usd matches the cost on the run's root span",
    test: async (dir) => {
      const c = Number(root(await traceOf(APP))?.attributes["app.cost_usd"]);
      return Number.isFinite(c) && Math.abs(Number(findings(dir).run_cost_usd) - c) < 0.0001;
    },
    tryNext:
      "Open http://localhost:7004, pick the HDC-2026-0142 trace, and copy app.cost_usd (4 decimal places is enough).",
  },
  {
    says: "tool_calls matches the execute_tool spans in that trace",
    test: async (dir) =>
      Number(findings(dir).tool_calls) ===
      (await traceOf(APP)).filter((s) => s.name.startsWith("execute_tool")).length,
    tryNext:
      "Count the amber bars in the waterfall: each is one execute_tool span. The green ones are model calls.",
  },
] satisfies Rule[];

// biome-ignore-all lint/style/useNamingConvention: run and spend JSON use names like run_id
// cap-the-spend: a runaway run stops itself. The release's step limit and dollar limit end it as
// stopped_budget, and the gateway's budget refusal reaches the resident as a clean error, not a
// hang. Each rule reads the gateway's spend log and the desk's own events.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { admin, runCommand, SECRETS } from "../world/cli/lib";
import { image, startDesk } from "./lib/desk";
import { postRun, type RunResult } from "./lib/sse";
import { replayMode, resetWorld, spend, URLS } from "./lib/world";

const RUNAWAY = "HDC-2026-0177";
const TIGHT_DESK = "http://localhost:3009";
const TIGHT_NAME = "hdc-check-tight-desk";
const DESK_BUDGET_USD = 2;

/** How one run ended: its events, its done event and what the gateway billed for it. */
type EndedRun = {
  names: string[];
  done: Record<string, unknown>;
  errorCode: unknown;
  calls: number;
  cost: number;
};

function dataOf(run: RunResult, eventName: string): Record<string, unknown> {
  const found = run.events.find((event) => event.event === eventName);
  const data = found?.data;
  if (typeof data === "object" && data !== null) return data as Record<string, unknown>;
  return {};
}

// Send one application and read how the run ended. A run that hangs counts as no answer.
async function endedRun(applicationId: string, base = URLS.desk): Promise<EndedRun | null> {
  const headers = { "x-resident-id": `cap-check-${Date.now()}` };
  const run = await postRun(applicationId, base, headers).catch(() => null);
  if (!run) return null;
  const done = dataOf(run, "done");
  const rows = (await spend()).filter((row) => done.run_id && row.run_id === done.run_id);
  const costs = rows.map((row) => Number(row.cost_usd ?? 0));
  return {
    names: run.events.map((event) => event.event),
    done,
    errorCode: dataOf(run, "error").code,
    calls: rows.length,
    cost: costs.reduce((total, cost) => total + cost, 0),
  };
}

// The runaway happens once per started desk, and two rules read it.
const runaways = new WeakMap<object, Promise<EndedRun | null>>();
function runaway(dir: string): Promise<EndedRun | null> {
  const started = startDesk(dir);
  let result = runaways.get(started);
  if (!result) {
    result = (async () => {
      if (!(await started).ok || !(await replayMode())) return null;
      await resetWorld();
      return endedRun(RUNAWAY);
    })();
    runaways.set(started, result);
  }
  return result;
}

const stoppedBudget = (run: EndedRun | null) => run?.done.status === "stopped_budget";

function residentSawCleanError(run: EndedRun | null): boolean {
  if (!run) return false;
  const errorAt = run.names.indexOf("error");
  const doneAt = run.names.indexOf("done");
  return run.errorCode === "budget_exceeded" && errorAt >= 0 && errorAt < doneAt;
}

async function runRecordStatus(base: string, runId: unknown): Promise<unknown> {
  const response = await fetch(`${base}/v1/runs/${runId}`).catch(() => null);
  if (!response?.ok) return null;
  const record = (await response.json()) as Record<string, unknown>;
  return record.status;
}

// A release with room for 100 steps but only 1 cent to spend, so only the dollar limit can stop it.
function tightReleaseFile(): string {
  const folder = mkdtempSync(join(tmpdir(), "hdc-tight-"));
  const file = join(folder, "release.json");
  const prompt = "Validate the application against the council's checklist.";
  const tight = { id: "v1", role: "fast", max_steps: 100, max_cost_usd: 0.01, prompt };
  writeFileSync(file, JSON.stringify(tight));
  return file;
}

async function startTightDesk(deskImage: string): Promise<boolean> {
  await runCommand(["docker", "rm", "-f", TIGHT_NAME]);
  const mounts = [
    ...["-v", `${tightReleaseFile()}:/limits/release.json:ro`],
    ...["-v", `${SECRETS}/desk_gateway_key:/run/secrets/gateway_key:ro`],
  ];
  const settings = ["-e", "RELEASE_FILE=/limits/release.json", ...mounts];
  const run = ["docker", "run", "-d", "--name", TIGHT_NAME, "--network", "hdc", "-p", "3009:3000"];
  await runCommand([...run, ...settings, deskImage]);
  for (let i = 0; i < 30; i++) {
    const answer = await fetch(`${TIGHT_DESK}/healthz`).catch(() => null);
    if (answer?.ok) return true;
    await Bun.sleep(500);
  }
  return false;
}

// Run the runaway on a copy of the desk whose release allows 100 steps and 1 cent.
async function dollarLimitStops(dir: string): Promise<boolean> {
  const deskImage = (await startDesk(dir)).ok ? await image() : null;
  if (!deskImage || !(await replayMode())) return false;
  await resetWorld();
  try {
    if (!(await startTightDesk(deskImage))) return false;
    const run = await endedRun(RUNAWAY, TIGHT_DESK);
    // The limit is checked before each call, so one call may cross it, never more.
    return stoppedBudget(run) && (run?.cost ?? 1) < 0.02 && (run?.calls ?? 99) < 25;
  } finally {
    await runCommand(["docker", "rm", "-f", TIGHT_NAME]);
  }
}

// Set the desk key's budget to $0, send a normal application, then give the budget back.
async function budgetRefusalIsClean(dir: string): Promise<boolean> {
  if (!(await startDesk(dir)).ok || !(await replayMode())) return false;
  await resetWorld();
  await admin("/admin/budget", { name: "desk", max_budget_usd: 0 });
  try {
    const startedAt = Date.now();
    const run = await endedRun("HDC-2026-0142");
    const endedQuickly = Date.now() - startedAt < 10_000;
    return endedQuickly && stoppedBudget(run) && residentSawCleanError(run);
  } finally {
    await admin("/admin/budget", { name: "desk", max_budget_usd: DESK_BUDGET_USD });
  }
}

export default [
  {
    says:
      "the runaway application HDC-2026-0177 ends as stopped_budget," +
      " in under 25 model calls and under $0.10 (spend log, replay mode)",
    test: async (dir) => {
      const run = await runaway(dir);
      return stoppedBudget(run) && (run?.calls ?? 99) < 25 && (run?.cost ?? 1) < 0.1;
    },
    tryNext:
      "Before each model call, compare run.steps with release.max_steps." +
      " When it is reached, end the run with the status stopped_budget.",
  },
  {
    says:
      "the resident sees an error event with code budget_exceeded before done," +
      " and GET /v1/runs/:id says stopped_budget",
    test: async (dir) => {
      const run = await runaway(dir);
      const status = await runRecordStatus(URLS.desk, run?.done.run_id);
      return residentSawCleanError(run) && status === "stopped_budget";
    },
    tryNext:
      'Yield { type: "error", code: "budget_exceeded", message } with a plain sentence for the' +
      " resident, then the done event.",
  },
  {
    says:
      "the dollar limit stops a run by itself:" +
      " a release with 100 steps and $0.01 stops near $0.01",
    test: dollarLimitStops,
    tryNext:
      "Stop when run.cost_usd reaches release.max_cost_usd, not only when the steps run out." +
      " Steps are not money: late steps cost more, because the conversation grows.",
  },
  {
    says:
      "when the gateway refuses the desk's key (429 budget_exceeded), the run ends at once" +
      " as stopped_budget with an error event, within 10 seconds",
    test: budgetRefusalIsClean,
    tryNext:
      "In the catch around chat(), check error.type. For budget_exceeded, yield the error event" +
      " and end the run as stopped_budget. Do not retry: the budget will not refill.",
  },
  {
    says: "a normal application still finishes as done inside the limits",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok || !(await replayMode())) return false;
      await resetWorld();
      const run = await endedRun("HDC-2026-0142");
      return run?.done.status === "done";
    },
    tryNext:
      "Check the limits before each call with >=, and count only model calls as steps," +
      " not tool calls.",
  },
] satisfies Rule[];

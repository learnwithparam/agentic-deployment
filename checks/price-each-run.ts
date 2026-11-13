// biome-ignore-all lint/style/useNamingConvention: span, spend and run JSON use names like run_id
// price-each-run: the root span of every run carries its cost, and the costs match the gateway's
// spend log. GET /v1/runs/:id answers the same cost. A run the desk cannot price says
// cost_unknown, never $0.
import type { Rule } from "../scripts/verify";
import { runCommand, SECRETS } from "../world/cli/lib";
import { image, startDesk } from "./lib/desk";
import { postRun, type RunResult } from "./lib/sse";
import { replayMode, resetWorld, type Span, type SpendRow, spans, spend, URLS } from "./lib/world";

const APPLICATIONS = [
  "HDC-2026-0142",
  "HDC-2026-0145",
  "HDC-2026-0150",
  "HDC-2026-0153",
  "HDC-2026-0160",
];
const ONE_CENT = 0.01;
const SAME_COST = 0.000_01;

/** One replayed run: its done event, its root span, its record and what the gateway billed. */
type PricedRun = {
  runId: string;
  done: Record<string, unknown>;
  root: Span | undefined;
  record: Record<string, unknown> | null;
  billed: number;
  billedCalls: number;
};

function doneEventOf(run: RunResult): Record<string, unknown> {
  const doneEvent = run.events.find((event) => event.event === "done");
  const data = doneEvent?.data;
  if (typeof data === "object" && data !== null) return data as Record<string, unknown>;
  return {};
}

const isRootOf = (span: Span, runId: string) =>
  !span.parent_span_id && span.attributes["run.id"] === runId;

// Spans travel in batches, so wait until every run's root span has reached the trace desk.
async function rootsOf(runIds: string[]): Promise<Span[]> {
  let roots: Span[] = [];
  for (let i = 0; i < 20; i++) {
    const all = await spans();
    roots = all.filter((span) => runIds.some((runId) => isRootOf(span, runId)));
    if (roots.length >= runIds.length) return roots;
    await Bun.sleep(500);
  }
  return roots;
}

async function runRecord(base: string, runId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${base}/v1/runs/${runId}`).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

async function pricedRun(done: Record<string, unknown>, roots: Span[], billed: SpendRow[]) {
  const runId = String(done.run_id ?? "");
  const rows = billed.filter((row) => runId && row.run_id === runId);
  const costs = rows.map((row) => Number(row.cost_usd ?? 0));
  return {
    runId,
    done,
    root: roots.find((span) => isRootOf(span, runId)),
    record: await runRecord(URLS.desk, runId),
    billed: costs.reduce((total, cost) => total + cost, 0),
    billedCalls: rows.length,
  };
}

async function replayFiveRuns(started: ReturnType<typeof startDesk>): Promise<PricedRun[]> {
  if (!(await started).ok || !(await replayMode())) return [];
  await resetWorld();
  const doneEvents: Record<string, unknown>[] = [];
  for (const id of APPLICATIONS) {
    const run = await postRun(id, undefined, { "x-resident-id": `price-check-${id}` });
    doneEvents.push(doneEventOf(run));
  }
  const roots = await rootsOf(doneEvents.map((done) => String(done.run_id ?? "")));
  const billed = await spend();
  const results: PricedRun[] = [];
  for (const done of doneEvents) results.push(await pricedRun(done, roots, billed));
  return results;
}

// The five runs happen once per started desk, and every rule below reads the same results.
const replays = new WeakMap<object, Promise<PricedRun[]>>();
function fiveRuns(dir: string): Promise<PricedRun[]> {
  const started = startDesk(dir);
  let results = replays.get(started);
  if (!results) {
    results = replayFiveRuns(started);
    replays.set(started, results);
  }
  return results;
}

const isClose = (first: unknown, second: number) =>
  typeof first === "number" && Math.abs(first - second) <= SAME_COST;

const spanCost = (run: PricedRun) => run.root?.attributes["app.cost_usd"];

async function spanCostsMatchTheSpendLog(dir: string): Promise<boolean> {
  const runs = await fiveRuns(dir);
  if (runs.length !== APPLICATIONS.length) return false;
  const eachMatches = runs.every((run) => run.billed > 0 && isClose(spanCost(run), run.billed));
  const spanTotal = runs.reduce((total, run) => total + Number(spanCost(run) ?? 0), 0);
  const billedTotal = runs.reduce((total, run) => total + run.billed, 0);
  return eachMatches && Math.abs(spanTotal - billedTotal) <= ONE_CENT;
}

async function doneEventsMatch(dir: string): Promise<boolean> {
  const runs = await fiveRuns(dir);
  const matches = (run: PricedRun) =>
    run.done.status === "done" && isClose(run.done.cost_usd, run.billed);
  return runs.length === APPLICATIONS.length && runs.every(matches);
}

function recordMatches(run: PricedRun): boolean {
  const record = run.record;
  return (
    record?.run_id === run.runId &&
    record.status === "done" &&
    record.steps === run.billedCalls &&
    isClose(record.cost_usd, run.billed)
  );
}

async function runsEndpointAnswers(dir: string): Promise<boolean> {
  const runs = await fiveRuns(dir);
  if (runs.length !== APPLICATIONS.length || !runs.every(recordMatches)) return false;
  const unknown = await fetch(`${URLS.desk}/v1/runs/no-such-run`);
  return unknown.status === 404;
}

// A gateway that answers like the real one but leaves out the price, as an unpriced model would.
const UNPRICED_GATEWAY = `
Bun.serve({ port: 7002, async fetch(request) {
  const url = new URL(request.url);
  const forwarded = await fetch("http://gateway:7002" + url.pathname, {
    method: request.method, headers: request.headers, body: await request.text() || undefined,
  });
  const answer = await forwarded.json();
  if (answer.usage) answer.usage.cost_usd = null;
  return Response.json(answer, { status: forwarded.status });
} });`;
const GATEWAY_NAME = "hdc-check-unpriced-gateway";
const DESK_NAME = "hdc-check-unpriced-desk";
const UNPRICED_DESK = "http://localhost:3009";

async function startUnpricedPair(deskImage: string): Promise<boolean> {
  await runCommand(["docker", "rm", "-f", GATEWAY_NAME, DESK_NAME]);
  const network = ["--network", "hdc"];
  const gateway = ["docker", "run", "-d", "--name", GATEWAY_NAME, ...network, "hdc-world:dev"];
  await runCommand([...gateway, "bun", "-e", UNPRICED_GATEWAY]);
  const keyFile = `${SECRETS}/desk_gateway_key:/run/secrets/gateway_key:ro`;
  const desk = ["docker", "run", "-d", "--name", DESK_NAME, ...network, "-p", "3009:3000"];
  const settings = ["-e", `GATEWAY_URL=http://${GATEWAY_NAME}:7002`, "-v", keyFile];
  await runCommand([...desk, ...settings, deskImage]);
  for (let i = 0; i < 30; i++) {
    const answer = await fetch(`${UNPRICED_DESK}/healthz`).catch(() => null);
    if (answer?.ok) return true;
    await Bun.sleep(500);
  }
  return false;
}

async function unpricedRunSaysSo(runId: string, done: Record<string, unknown>) {
  const roots = await rootsOf([runId]);
  const root = roots[0];
  const record = await runRecord(UNPRICED_DESK, runId);
  return (
    done.status === "cost_unknown" &&
    done.cost_usd === null &&
    root?.attributes["app.cost_unknown"] === true &&
    root.attributes["app.cost_usd"] === undefined &&
    record?.status === "cost_unknown" &&
    record.cost_usd === null
  );
}

// Run one application on a copy of the desk whose gateway gives no prices.
async function playUnpricedRun(started: ReturnType<typeof startDesk>): Promise<boolean> {
  const deskImage = (await started).ok ? await image() : null;
  if (!deskImage || !(await replayMode())) return false;
  try {
    if (!(await startUnpricedPair(deskImage))) return false;
    const headers = { "x-resident-id": "price-check-unpriced" };
    const run = await postRun("HDC-2026-0148", UNPRICED_DESK, headers);
    const done = doneEventOf(run);
    return await unpricedRunSaysSo(String(done.run_id ?? ""), done);
  } finally {
    await runCommand(["docker", "rm", "-f", GATEWAY_NAME, DESK_NAME]);
  }
}

const unpricedRuns = new WeakMap<object, Promise<boolean>>();
function unpricedRun(dir: string): Promise<boolean> {
  const started = startDesk(dir);
  let result = unpricedRuns.get(started);
  if (!result) {
    result = playUnpricedRun(started);
    unpricedRuns.set(started, result);
  }
  return result;
}

export default [
  {
    says:
      "the root span of each of 5 replayed runs carries app.cost_usd, and it matches the" +
      " gateway's spend log (the five add up within 1 cent)",
    test: spanCostsMatchTheSpendLog,
    tryNext:
      "Add every model call's cost to the run's total. When the run ends, set app.cost_usd on" +
      " the root span, rounded to 6 decimal places.",
  },
  {
    says: "each done event says status done and the same cost_usd",
    test: doneEventsMatch,
    tryNext: "Build the done event from the same total you put on the root span.",
  },
  {
    says:
      "GET /v1/runs/:id answers run_id, status, steps and cost_usd," +
      " and 404 for a run it never saw",
    test: runsEndpointAnswers,
    tryNext:
      "Keep each run in a Map by run_id (src/runs.ts). steps is the number of model calls." +
      ' Answer 404 with {"error": "no such run"} when the id is not there.',
  },
  {
    says:
      "a run the gateway cannot price ends as cost_unknown, with cost_usd null, never 0" +
      " (on the span, the done event and GET /v1/runs/:id)",
    test: unpricedRun,
    tryNext:
      "The gateway sends cost_usd null when it has no price. Keep null as null: the total" +
      " becomes null, the status cost_unknown, and the root span gets app.cost_unknown true.",
  },
] satisfies Rule[];

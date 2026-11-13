// biome-ignore-all lint/style/useNamingConvention: span and spend JSON use names like run_id
// trace-every-run: every run is one trace in the trace desk. A root span names the run, the
// application and the release; a child span covers each model call and each tool call. No span
// holds a resident's name, email or phone.
import type { Rule } from "../scripts/verify";
import { startDesk } from "./lib/desk";
import { dataField, postRun, type RunResult } from "./lib/sse";
import {
  applications,
  replayMode,
  resetWorld,
  type Span,
  type SpendRow,
  spans,
  spend,
} from "./lib/world";

const APPLICATIONS = [
  "HDC-2026-0142",
  "HDC-2026-0145",
  "HDC-2026-0150",
  "HDC-2026-0153",
  "HDC-2026-0160",
];
const TOOL_NAMES = ["read_application", "check_checklist", "calculate_fee", "write_decision"];

/** One replayed run: what the desk streamed, its spans, and what the gateway billed for it. */
type TracedRun = {
  applicationId: string;
  runId: string;
  toolEvents: number;
  roots: Span[];
  trace: Span[];
  spendRows: SpendRow[];
};

function runIdOf(run: RunResult): string {
  const doneEvent = run.events.find((event) => event.event === "done");
  const runId = doneEvent ? dataField(doneEvent, "run_id") : undefined;
  return typeof runId === "string" ? runId : "";
}

const isRootOf = (span: Span, runId: string) =>
  !span.parent_span_id && span.attributes["run.id"] === runId;

// Spans travel in batches, so wait until every run's root span has reached the trace desk.
async function spansOfRuns(runIds: string[]): Promise<Span[]> {
  let all: Span[] = [];
  for (let i = 0; i < 20; i++) {
    all = await spans();
    const everyRootArrived = runIds.every((runId) => all.some((span) => isRootOf(span, runId)));
    if (everyRootArrived) return all;
    await Bun.sleep(500);
  }
  return all;
}

function traceOfRun(applicationId: string, run: RunResult, all: Span[], billed: SpendRow[]) {
  const runId = runIdOf(run);
  const roots = all.filter((span) => isRootOf(span, runId));
  const traceId = roots[0]?.trace_id;
  return {
    applicationId,
    runId,
    toolEvents: run.events.filter((event) => event.event === "tool").length,
    roots,
    trace: all.filter((span) => traceId && span.trace_id === traceId),
    spendRows: billed.filter((row) => runId && row.run_id === runId),
  };
}

async function replayFiveRuns(started: ReturnType<typeof startDesk>): Promise<TracedRun[]> {
  if (!(await started).ok || !(await replayMode())) return [];
  await resetWorld();
  const results: RunResult[] = [];
  for (const id of APPLICATIONS) {
    results.push(await postRun(id, undefined, { "x-resident-id": `trace-check-${id}` }));
  }
  const all = await spansOfRuns(results.map(runIdOf));
  const billed = await spend();
  return results.map((run, i) => traceOfRun(APPLICATIONS[i], run, all, billed));
}

// The five runs happen once per started desk, and every rule below reads the same results.
const replays = new WeakMap<object, Promise<TracedRun[]>>();
function fiveRuns(dir: string): Promise<TracedRun[]> {
  const started = startDesk(dir);
  let results = replays.get(started);
  if (!results) {
    results = replayFiveRuns(started);
    replays.set(started, results);
  }
  return results;
}

async function everyRun(dir: string, test: (run: TracedRun) => boolean): Promise<boolean> {
  const runs = await fiveRuns(dir);
  return runs.length === APPLICATIONS.length && runs.every(test);
}

function hasOneGoodRoot(run: TracedRun): boolean {
  if (run.roots.length !== 1) return false;
  const attributes = run.roots[0].attributes;
  return attributes["application.id"] === run.applicationId && attributes["release.id"] === "v1";
}

const chatSpans = (run: TracedRun) => run.trace.filter((span) => span.name.startsWith("chat "));
const toolSpans = (run: TracedRun) =>
  run.trace.filter((span) => span.name.startsWith("execute_tool "));

function oneChatSpanPerModelCall(run: TracedRun): boolean {
  const calls = chatSpans(run);
  return calls.length > 0 && calls.length === run.spendRows.length;
}

function sumOf(values: unknown[]): number {
  return values.reduce<number>((total, value) => total + Number(value ?? 0), 0);
}

// The token counts on the spans must add up to what the gateway billed for the run.
function tokensMatchTheGateway(run: TracedRun): boolean {
  const calls = chatSpans(run);
  const spanInput = sumOf(calls.map((span) => span.attributes["gen_ai.usage.input_tokens"]));
  const spanOutput = sumOf(calls.map((span) => span.attributes["gen_ai.usage.output_tokens"]));
  const billedInput = sumOf(run.spendRows.map((row) => row.input_tokens));
  const billedOutput = sumOf(run.spendRows.map((row) => row.output_tokens));
  return calls.length > 0 && spanInput === billedInput && spanOutput === billedOutput;
}

function oneSpanPerToolCall(run: TracedRun): boolean {
  const tools = toolSpans(run);
  const names = new Set(tools.map((span) => span.name.replace("execute_tool ", "")));
  const everyToolSeen = TOOL_NAMES.every((name) => names.has(name));
  return everyToolSeen && tools.length === run.toolEvents;
}

// Everything a resident could be found by: their name, email address and phone number.
function residentDetails(): string[] {
  const chosen = applications().filter((application) => APPLICATIONS.includes(application.id));
  return chosen.flatMap(({ applicant }) => [applicant.name, applicant.email, applicant.phone]);
}

function holdsNoResidentDetails(run: TracedRun): boolean {
  const details = residentDetails();
  const spanText = JSON.stringify(run.trace.map((span) => span.attributes));
  return run.trace.length > 0 && !details.some((detail) => spanText.includes(detail));
}

export default [
  {
    says:
      "each of 5 replayed runs has one root span with run.id, application.id and release.id" +
      " (replay mode)",
    test: (dir) => everyRun(dir, hasOneGoodRoot),
    tryNext:
      "In runAgent, start one span with tracer.startSpan and set run.id, application.id and" +
      " release.id on it. End it when the run ends.",
  },
  {
    says:
      "every model call is a chat span in the run's trace," +
      " one for each call the gateway billed",
    test: (dir) => everyRun(dir, oneChatSpanPerModelCall),
    tryNext:
      "Wrap each chat() call in inChildSpan with the name chat and the role. Run the loop inside" +
      " context.with(trace.setSpan(context.active(), runSpan), ...) so the root is the parent.",
  },
  {
    says: "the token counts on the chat spans add up to the gateway's spend log for the run",
    test: (dir) => everyRun(dir, tokensMatchTheGateway),
    tryNext:
      "Read usage.prompt_tokens and usage.completion_tokens in src/model.ts, and set them as" +
      " gen_ai.usage.input_tokens and gen_ai.usage.output_tokens on the chat span.",
  },
  {
    says: "every tool call is an execute_tool span in the run's trace",
    test: (dir) => everyRun(dir, oneSpanPerToolCall),
    tryNext:
      "Wrap each runTool call in inChildSpan with the name execute_tool and the tool's name," +
      " inside the run's context like the chat spans.",
  },
  {
    says: "no span holds a resident's name, email or phone number",
    test: (dir) => everyRun(dir, holdsNoResidentDetails),
    tryNext:
      "Put names and counts on spans, never the messages or what a tool answered." +
      " Tool answers and letters hold the resident's name.",
  },
] satisfies Rule[];

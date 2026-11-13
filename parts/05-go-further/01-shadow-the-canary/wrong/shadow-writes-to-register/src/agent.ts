// biome-ignore-all lint/style/useNamingConvention: runs and events keep wire names like run_id
// The agent loop, with three brakes and a journal:
//  - a step limit and a dollar limit per run (from the release), so a runaway run stops itself
//  - the gateway's budget per key, turned into a clean error for the resident
//  - every step saved, so a killed run resumes where it stopped
import {
  context,
  type Span,
  SpanStatusCode,
  type Context as TraceContext,
  trace,
} from "@opentelemetry/api";
import { currentRelease, DRY_RUN, type Release } from "./config";
import { chat, type GatewayError, type Message, type Reply, type ToolCall } from "./model";
import { type Run, save } from "./runs";
import { inChildSpan, tracer } from "./telemetry";
import { runTool, TOOLS } from "./tools";

// What the desk tells the resident's page while a run goes on.
export type Event =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: "ok" | "error" }
  | { type: "error"; code: string; message: string }
  | { type: "done"; run_id: string; status: string; cost_usd: number | null };

// How many runs ended, keyed by "release|status". /metrics reads it.
export const endedRunCounts = new Map<string, number>();

export function newRun(applicationId: string, runId: string, release = currentRelease()): Run {
  return {
    run_id: runId,
    application_id: applicationId,
    release_id: release.id,
    status: "running",
    steps: 0,
    cost_usd: 0,
    messages: [
      { role: "system", content: release.prompt },
      { role: "user", content: `Validate application ${applicationId}.` },
    ],
  };
}

// Once one step's cost is unknown, the cost of the whole run is unknown too.
function addCost(total: number | null, stepCost: number | null): number | null {
  if (total === null || stepCost === null) return null;
  return total + stepCost;
}

// Costs are fractions of a cent, so six decimal places keep them exact enough to add up.
function roundCost(cost: number): number {
  return Number(cost.toFixed(6));
}

// A tool reports a problem by answering with an error, instead of throwing.
function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

// Split the answer into words, so the resident sees it arrive a little at a time.
function wordsOf(text: string | null): string[] {
  return (text ?? "").match(/\S+\s*/g) ?? [];
}

// The run's own span. Every model call and tool call in the run is a child of it.
function startRunSpan(run: Run, release: Release): Span {
  return tracer.startSpan("invoke_agent permit-desk", {
    attributes: {
      "run.id": run.run_id,
      "application.id": run.application_id,
      "release.id": release.id,
      "gen_ai.operation.name": "invoke_agent",
      "run.resumed": run.steps > 0,
      "run.dry_run": DRY_RUN,
    },
  });
}

// A run in progress, with the release it follows and the span its steps are traced under.
type ActiveRun = { run: Run; release: Release; span: Span; traceContext: TraceContext };

// Save the run's final status, close its span, count it for /metrics and tell the resident.
function endRun(active: ActiveRun, status: string): Event {
  const { run, release, span } = active;
  run.status = status;
  save(run);
  span.setAttributes({ "run.status": status, "run.steps": run.steps });
  if (run.cost_usd !== null) span.setAttribute("app.cost_usd", roundCost(run.cost_usd));
  else span.setAttribute("app.cost_unknown", true);
  if (status === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
  const countKey = `${release.id}|${status}`;
  endedRunCounts.set(countKey, (endedRunCounts.get(countKey) ?? 0) + 1);
  const cost = run.cost_usd === null ? null : roundCost(run.cost_usd);
  return { type: "done", run_id: run.run_id, status, cost_usd: cost };
}

// A resumed run may have stopped between asking for tools and getting their results.
function unansweredToolCalls(messages: Message[]): ToolCall[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [];
  const toolMessages = messages.filter((message) => message.role === "tool");
  const answeredIds = new Set(toolMessages.map((message) => message.tool_call_id));
  return (last.tool_calls ?? []).filter((call) => !answeredIds.has(call.id));
}

// Run one tool the model asked for. A tool that throws becomes an error the model can read.
async function runToolCall(call: ToolCall, runId: string): Promise<unknown> {
  try {
    const toolArguments = JSON.parse(call.function.arguments || "{}");
    return await runTool(call.function.name, toolArguments, runId);
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function runToolInSpan(call: ToolCall, runId: string): Promise<unknown> {
  const toolName = call.function.name;
  const attributes = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": toolName };
  return inChildSpan(`execute_tool ${toolName}`, attributes, async (span) => {
    const result = await runToolCall(call, runId);
    if (isToolError(result)) span.setStatus({ code: SpanStatusCode.ERROR });
    return result;
  });
}

// Run each tool call, and save the run after each result, so a restart never runs one twice.
async function* runToolCalls(active: ActiveRun, toolCalls: ToolCall[]): AsyncGenerator<Event> {
  const { run } = active;
  for (const call of toolCalls) {
    const result = await context.with(active.traceContext, () => runToolInSpan(call, run.run_id));
    const status = isToolError(result) ? "error" : "ok";
    yield { type: "tool", name: call.function.name, status };
    run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    save(run);
  }
}

// Ask the model for the next step, and put its token counts and price on the span.
function askModelInSpan(run: Run, release: Release): Promise<Reply> {
  const attributes = { "gen_ai.operation.name": "chat", "gen_ai.request.model": release.role };
  return inChildSpan(`chat ${release.role}`, attributes, async (span) => {
    const reply = await chat(release.role, run.messages, TOOLS, run.run_id);
    span.setAttributes({
      "gen_ai.usage.input_tokens": reply.inputTokens,
      "gen_ai.usage.output_tokens": reply.outputTokens,
      ...(reply.costUsd === null ? {} : { "app.cost_usd": reply.costUsd }),
    });
    return reply;
  });
}

// The release's own brakes: stop before a step that would go past its limits.
function reachedReleaseLimits(run: Run, release: Release): boolean {
  return run.steps >= release.max_steps || (run.cost_usd ?? 0) >= release.max_cost_usd;
}

function releaseLimitsEvent(run: Run): Event {
  const spent = (run.cost_usd ?? 0).toFixed(4);
  return {
    type: "error",
    code: "budget_exceeded",
    message:
      `This check stopped after ${run.steps} steps and $${spent}. ` +
      "A member of staff will look at it.",
  };
}

// The gateway's brake: a key that has spent its budget ends the run with a note for the resident.
function gatewayFailure(error: unknown): { event: Event; status: string } {
  const gatewayError = error as GatewayError;
  if (gatewayError.type !== "budget_exceeded") {
    const event: Event = { type: "error", code: "model_error", message: gatewayError.message };
    return { event, status: "failed" };
  }
  const message =
    "The desk has reached its spending limit. Your application is saved and staff will check it.";
  return { event: { type: "error", code: "budget_exceeded", message }, status: "stopped_budget" };
}

// The model's last message asked for no tools, so it is the answer and the run is over.
async function* finishWithAnswer(active: ActiveRun, answer: string | null): AsyncGenerator<Event> {
  for (const word of wordsOf(answer)) yield { type: "token", text: word };
  yield endRun(active, active.run.cost_usd === null ? "cost_unknown" : "done");
}

// One step of the run: finish tool calls left over, or end the run, or ask the model again.
// Answers true once the run has ended.
async function* takeStep(active: ActiveRun): AsyncGenerator<Event, boolean> {
  const { run, release } = active;
  const pending = unansweredToolCalls(run.messages);
  if (pending.length) {
    yield* runToolCalls(active, pending);
    return false;
  }
  const last = run.messages.at(-1);
  if (last?.role === "assistant") {
    yield* finishWithAnswer(active, last.content);
    return true;
  }
  if (reachedReleaseLimits(run, release)) {
    yield releaseLimitsEvent(run);
    yield endRun(active, "stopped_budget");
    return true;
  }
  let reply: Reply;
  try {
    reply = await context.with(active.traceContext, () => askModelInSpan(run, release));
  } catch (error) {
    const failure = gatewayFailure(error);
    yield failure.event;
    yield endRun(active, failure.status);
    return true;
  }
  run.steps += 1;
  run.cost_usd = addCost(run.cost_usd, reply.costUsd);
  run.messages.push(reply.message);
  save(run);
  return false;
}

export async function* runAgent(
  run: Run,
  release: Release = currentRelease(),
): AsyncGenerator<Event> {
  const span = startRunSpan(run, release);
  const active: ActiveRun = {
    run,
    release,
    span,
    traceContext: trace.setSpan(context.active(), span),
  };
  save(run);
  let ended = false;
  while (!ended) ended = yield* takeStep(active);
}

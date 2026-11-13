// biome-ignore-all lint/style/useNamingConvention: the events the page reads use names like run_id
// The agent loop: ask the model, run the tools it asks for, repeat until it answers in words.
// Every run is one trace: a root span for the run, a child span for each model call and each tool.
// The root span and the run's record carry the run's cost, or say that the cost is unknown.
// Two brakes stop a runaway run: the release's step limit and dollar limit, checked before every
// model call, and the gateway's budget for the desk's key, which ends the run with a clean note.
// The run is saved to the journal after every step, so a run cut short by a restart goes on from
// its last saved step.
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { release } from "./config";
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

// Once one step's cost is unknown, the cost of the whole run is unknown too. Never count it as 0.
function addCost(total: number | null, stepCost: number | null): number | null {
  if (total === null || stepCost === null) return null;
  return total + stepCost;
}

// Costs are fractions of a cent, so six decimal places keep them exact enough to add up.
function roundCost(cost: number | null): number | null {
  if (cost === null) return null;
  return Number(cost.toFixed(6));
}

// The release's own brakes: stop before a model call that would go past its limits.
function reachedReleaseLimits(run: Run): boolean {
  const spent = run.cost_usd ?? 0;
  return run.steps >= release.max_steps || spent >= release.max_cost_usd;
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
// Any other gateway error fails the run. Never retry a budget refusal: it will not change.
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

// A tool reports a problem by answering with an error, instead of throwing.
function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
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

// One span per tool call. Only the tool's name goes on the span, never what the tool answered,
// because answers hold the resident's name.
function runToolInSpan(call: ToolCall, runId: string): Promise<unknown> {
  const toolName = call.function.name;
  const attributes = { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": toolName };
  return inChildSpan(`execute_tool ${toolName}`, attributes, async (span) => {
    const result = await runToolCall(call, runId);
    if (isToolError(result)) span.setStatus({ code: SpanStatusCode.ERROR });
    return result;
  });
}

// Run each tool the model asked for. Save the run after each result, so a restart never runs a
// finished tool call again.
async function* runToolCalls(toolCalls: ToolCall[], run: Run): AsyncGenerator<Event> {
  for (const call of toolCalls) {
    const result = await runToolInSpan(call, run.run_id);
    const status = isToolError(result) ? "error" : "ok";
    yield { type: "tool", name: call.function.name, status };
    run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    save(run);
  }
}

// A run cut short may have stopped after the model asked for tools, before every tool answered.
function unansweredToolCalls(messages: Message[]): ToolCall[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return [];
  const toolMessages = messages.filter((message) => message.role === "tool");
  const answeredIds = new Set(toolMessages.map((message) => message.tool_call_id));
  return (last.tool_calls ?? []).filter((call) => !answeredIds.has(call.id));
}

// One span per model call, with the token counts the gateway reported.
function askModelInSpan(messages: Message[], runId: string): Promise<Reply> {
  const attributes = { "gen_ai.operation.name": "chat", "gen_ai.request.model": release.role };
  return inChildSpan(`chat ${release.role}`, attributes, async (span) => {
    const reply = await chat(release.role, messages, TOOLS, runId);
    span.setAttribute("gen_ai.usage.input_tokens", reply.inputTokens);
    span.setAttribute("gen_ai.usage.output_tokens", reply.outputTokens);
    return reply;
  });
}

// Split the answer into words, so the resident sees it arrive a little at a time.
function wordsOf(text: string | null): string[] {
  return (text ?? "").match(/\S+\s*/g) ?? [];
}

// The run's own span. It says which run, which application and which release, and whether
// the run picked up again after a restart.
function startRunSpan(run: Run): Span {
  return tracer.startSpan("invoke_agent permit-desk", {
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "run.id": run.run_id,
      "application.id": run.application_id,
      "release.id": release.id,
      "run.resumed": run.steps > 0,
    },
  });
}

// The run is over: save its status, put its cost on the root span and tell the resident.
function endRun(run: Run, runSpan: Span, status: string): Event {
  run.status = status;
  run.cost_usd = roundCost(run.cost_usd);
  save(run);
  runSpan.setAttribute("run.status", status);
  runSpan.setAttribute("run.steps", run.steps);
  if (run.cost_usd === null) runSpan.setAttribute("app.cost_unknown", true);
  else runSpan.setAttribute("app.cost_usd", run.cost_usd);
  return { type: "done", run_id: run.run_id, status, cost_usd: run.cost_usd };
}

// The model asked for no tools, so its message is the answer and the run is over.
async function* finishWithAnswer(run: Run, runSpan: Span, answer: string | null) {
  for (const word of wordsOf(answer)) yield { type: "token", text: word } as Event;
  // A run with a missing price is not free. Say so, instead of reporting $0.
  const status = run.cost_usd === null ? "cost_unknown" : "done";
  yield endRun(run, runSpan, status);
}

// Ask the model for the next step. Answers false when the run has ended instead.
async function* askForNextStep(run: Run, runSpan: Span): AsyncGenerator<Event, boolean> {
  if (reachedReleaseLimits(run)) {
    yield releaseLimitsEvent(run);
    yield endRun(run, runSpan, "stopped_budget");
    return false;
  }
  let reply: Reply;
  try {
    reply = await askModelInSpan(run.messages, run.run_id);
  } catch (error) {
    const failure = gatewayFailure(error);
    yield failure.event;
    yield endRun(run, runSpan, failure.status);
    return false;
  }
  run.steps += 1;
  run.cost_usd = addCost(run.cost_usd, reply.costUsd);
  run.messages.push(reply.message);
  save(run);
  return true;
}

// Each turn looks at the last saved message, so a resumed run goes on from where it stopped.
async function* agentLoop(run: Run, runSpan: Span): AsyncGenerator<Event> {
  while (true) {
    const pending = unansweredToolCalls(run.messages);
    const last = run.messages.at(-1);
    if (pending.length > 0) {
      yield* runToolCalls(pending, run);
    } else if (last?.role === "assistant") {
      // The model asked for no tools, so its last message is the answer.
      yield* finishWithAnswer(run, runSpan, last.content);
      return;
    } else {
      const goOn = yield* askForNextStep(run, runSpan);
      if (!goOn) return;
    }
  }
}

export async function* runAgent(run: Run): AsyncGenerator<Event> {
  const runSpan = startRunSpan(run);
  // Make the run's span the parent of every span the loop starts.
  const runContext = trace.setSpan(context.active(), runSpan);
  const steps = agentLoop(run, runSpan);
  try {
    while (true) {
      const next = await context.with(runContext, () => steps.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    runSpan.end();
  }
}

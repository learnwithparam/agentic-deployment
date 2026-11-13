// biome-ignore-all lint/style/useNamingConvention: the events the page reads use names like run_id
// The agent loop: ask the model, run the tools it asks for, repeat until it answers in words.
// Every run is one trace: a root span for the run, a child span for each model call and each tool.
import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { release } from "./config";
import { chat, type GatewayError, type Message, type Reply, type ToolCall } from "./model";
import { inChildSpan, tracer } from "./telemetry";
import { runTool, TOOLS } from "./tools";

// What the desk tells the resident's page while a run goes on.
export type Event =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: "ok" | "error" }
  | { type: "error"; code: string; message: string }
  | { type: "done"; run_id: string; status: string; cost_usd: number | null };

// Once one step's cost is unknown, the cost of the whole run is unknown too.
function addCost(total: number | null, stepCost: number | null): number | null {
  if (total === null || stepCost === null) return null;
  return total + stepCost;
}

function gatewayErrorEvent(error: unknown): Event {
  const gatewayError = error as GatewayError;
  const outOfBudget = gatewayError.type === "budget_exceeded";
  return {
    type: "error",
    code: outOfBudget ? "budget_exceeded" : "model_error",
    message: gatewayError.message,
  };
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

// Run each tool the model asked for, and add every result to the conversation for its next step.
async function* runToolCalls(
  toolCalls: ToolCall[],
  messages: Message[],
  runId: string,
): AsyncGenerator<Event> {
  for (const call of toolCalls) {
    const result = await runToolInSpan(call, runId);
    const status = isToolError(result) ? "error" : "ok";
    yield { type: "tool", name: call.function.name, status };
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
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

// The run's own span. It says which run, which application and which release.
function startRunSpan(applicationId: string, runId: string): Span {
  return tracer.startSpan("invoke_agent permit-desk", {
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "run.id": runId,
      "application.id": applicationId,
      "release.id": release.id,
    },
  });
}

async function* agentLoop(applicationId: string, runId: string): AsyncGenerator<Event> {
  const messages: Message[] = [
    { role: "system", content: release.prompt },
    { role: "user", content: `Validate application ${applicationId}.` },
  ];
  let cost: number | null = 0;
  while (true) {
    let reply: Reply;
    try {
      reply = await askModelInSpan(messages, runId);
    } catch (error) {
      yield gatewayErrorEvent(error);
      yield { type: "done", run_id: runId, status: "failed", cost_usd: cost };
      return;
    }
    cost = addCost(cost, reply.costUsd);
    messages.push(reply.message);
    const toolCalls = reply.message.tool_calls ?? [];
    // No tool calls means the model has finished and answered in words.
    if (toolCalls.length === 0) {
      for (const word of wordsOf(reply.message.content)) yield { type: "token", text: word };
      yield { type: "done", run_id: runId, status: "done", cost_usd: cost };
      return;
    }
    yield* runToolCalls(toolCalls, messages, runId);
  }
}

export async function* runAgent(applicationId: string, runId: string): AsyncGenerator<Event> {
  const runSpan = startRunSpan(applicationId, runId);
  try {
    for await (const event of agentLoop(applicationId, runId)) {
      if (event.type === "done") runSpan.setAttribute("run.status", event.status);
      yield event;
    }
  } finally {
    runSpan.end();
  }
}

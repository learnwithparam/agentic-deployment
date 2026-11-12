// biome-ignore-all lint/style/useNamingConvention: the events the page reads use names like run_id
// The agent loop: ask the model, run the tools it asks for, repeat until it answers in words.
import { release } from "./config";
import { chat, type GatewayError, type Message, type Reply, type ToolCall } from "./model";
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

// Run each tool the model asked for, and add every result to the conversation for its next step.
async function* runToolCalls(
  toolCalls: ToolCall[],
  messages: Message[],
  runId: string,
): AsyncGenerator<Event> {
  for (const call of toolCalls) {
    const result = await runToolCall(call, runId);
    const status = isToolError(result) ? "error" : "ok";
    yield { type: "tool", name: call.function.name, status };
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}

// Split the answer into words, so the resident sees it arrive a little at a time.
function wordsOf(text: string | null): string[] {
  return (text ?? "").match(/\S+\s*/g) ?? [];
}

export async function* runAgent(applicationId: string, runId: string): AsyncGenerator<Event> {
  const messages: Message[] = [
    { role: "system", content: release.prompt },
    { role: "user", content: `Validate application ${applicationId}.` },
  ];
  let cost: number | null = 0;
  while (true) {
    let reply: Reply;
    try {
      reply = await chat(release.role, messages, TOOLS, runId);
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

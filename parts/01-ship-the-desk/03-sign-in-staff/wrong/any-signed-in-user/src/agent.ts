// The agent loop: ask the model, run the tools it asks for, repeat until it answers in words.
import { release } from "./config";
import { chat, GatewayError, type Message } from "./model";
import { TOOLS, runTool } from "./tools";

export type Event =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: "ok" | "error" }
  | { type: "error"; code: string; message: string }
  | { type: "done"; run_id: string; status: string; cost_usd: number | null };

export async function* runAgent(applicationId: string, runId: string): AsyncGenerator<Event> {
  const messages: Message[] = [
    { role: "system", content: release.prompt },
    { role: "user", content: `Validate application ${applicationId}.` },
  ];
  let cost: number | null = 0;
  while (true) {
    let reply;
    try {
      reply = await chat(release.role, messages, TOOLS, runId);
    } catch (e) {
      const g = e as GatewayError;
      yield { type: "error", code: g.type === "budget_exceeded" ? "budget_exceeded" : "model_error", message: g.message };
      yield { type: "done", run_id: runId, status: "failed", cost_usd: cost };
      return;
    }
    cost = cost === null || reply.costUsd === null ? null : cost + reply.costUsd;
    messages.push(reply.message);
    const calls = reply.message.tool_calls ?? [];
    if (calls.length === 0) {
      // Send the answer in small pieces so the resident sees it arrive.
      for (const piece of (reply.message.content ?? "").match(/\S+\s*/g) ?? []) yield { type: "token", text: piece };
      yield { type: "done", run_id: runId, status: "done", cost_usd: cost };
      return;
    }
    for (const c of calls) {
      let result: unknown;
      try { result = await runTool(c.function.name, JSON.parse(c.function.arguments || "{}"), runId); }
      catch (e) { result = { error: (e as Error).message }; }
      const failed = typeof result === "object" && result !== null && "error" in result;
      yield { type: "tool", name: c.function.name, status: failed ? "error" : "ok" };
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
    }
  }
}

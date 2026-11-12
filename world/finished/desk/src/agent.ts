// The agent loop, with three brakes and a journal:
//  - a step limit and a dollar limit per run (from the release), so a runaway run stops itself
//  - the gateway's budget per key, turned into a clean error for the resident
//  - every step saved, so a killed run resumes where it stopped
import { SpanStatusCode, trace, context } from "@opentelemetry/api";
import { currentRelease, type Release } from "./config";
import { chat, GatewayError, type Message } from "./model";
import { TOOLS, runTool } from "./tools";
import { save, type Run } from "./runs";
import { tracer, span } from "./telemetry";

export type Event =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; status: "ok" | "error" }
  | { type: "error"; code: string; message: string }
  | { type: "done"; run_id: string; status: string; cost_usd: number | null };

export const finished = new Map<string, number>(); // run status counts for /metrics, by "release|status"

export function newRun(applicationId: string, runId: string, release = currentRelease()): Run {
  return { run_id: runId, application_id: applicationId, release_id: release.id, status: "running", steps: 0, cost_usd: 0,
    messages: [{ role: "system", content: release.prompt }, { role: "user", content: `Validate application ${applicationId}.` }] };
}

export async function* runAgent(run: Run, release: Release = currentRelease()): AsyncGenerator<Event> {
  const root = tracer.startSpan("invoke_agent permit-desk", { attributes: {
    "run.id": run.run_id, "application.id": run.application_id, "release.id": release.id, "gen_ai.operation.name": "invoke_agent",
    "run.resumed": run.steps > 0 } });
  const ctx = trace.setSpan(context.active(), root);
  const end = (status: string): Event => {
    run.status = status; save(run);
    root.setAttributes({ "run.status": status, "run.steps": run.steps });
    if (run.cost_usd !== null) root.setAttribute("app.cost_usd", Number(run.cost_usd.toFixed(6)));
    else root.setAttribute("app.cost_unknown", true);
    if (status === "failed") root.setStatus({ code: SpanStatusCode.ERROR });
    root.end();
    finished.set(`${release.id}|${status}`, (finished.get(`${release.id}|${status}`) ?? 0) + 1);
    return { type: "done", run_id: run.run_id, status, cost_usd: run.cost_usd === null ? null : Number(run.cost_usd.toFixed(6)) };
  };
  save(run);
  while (true) {
    // A resumed run may stop between asking for tools and getting their results. Run those first.
    const last = run.messages.at(-1);
    const answered = new Set(run.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    const pending = last?.role === "assistant" ? (last.tool_calls ?? []).filter((c) => !answered.has(c.id)) : [];
    if (pending.length) {
      for (const c of pending) {
        const result = await context.with(ctx, () => span(`execute_tool ${c.function.name}`, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": c.function.name }, async (s) => {
          let r: unknown;
          try { r = await runTool(c.function.name, JSON.parse(c.function.arguments || "{}"), run.run_id); }
          catch (e) { r = { error: (e as Error).message }; }
          if (typeof r === "object" && r !== null && "error" in r) s.setStatus({ code: SpanStatusCode.ERROR });
          return r;
        }));
        const failed = typeof result === "object" && result !== null && "error" in result;
        yield { type: "tool", name: c.function.name, status: failed ? "error" : "ok" };
        run.messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
        save(run);
      }
      continue;
    }
    if (last?.role === "assistant") {
      for (const piece of (last.content ?? "").match(/\S+\s*/g) ?? []) yield { type: "token", text: piece };
      yield end(run.cost_usd === null ? "cost_unknown" : "done");
      return;
    }
    if (run.steps >= release.max_steps || (run.cost_usd ?? 0) >= release.max_cost_usd) {
      yield { type: "error", code: "budget_exceeded", message: `This check stopped after ${run.steps} steps and $${(run.cost_usd ?? 0).toFixed(4)}. A member of staff will look at it.` };
      yield end("stopped_budget");
      return;
    }
    let reply;
    try {
      reply = await context.with(ctx, () => span(`chat ${release.role}`, { "gen_ai.operation.name": "chat", "gen_ai.request.model": release.role }, async (s) => {
        const r = await chat(release.role, run.messages, TOOLS, run.run_id);
        s.setAttributes({ "gen_ai.usage.input_tokens": r.inputTokens, "gen_ai.usage.output_tokens": r.outputTokens, ...(r.costUsd === null ? {} : { "app.cost_usd": r.costUsd }) });
        return r;
      }));
    } catch (e) {
      const g = e as GatewayError;
      const budget = g.type === "budget_exceeded";
      yield { type: "error", code: budget ? "budget_exceeded" : "model_error", message: budget ? "The desk has reached its spending limit. Your application is saved and staff will check it." : g.message };
      yield end(budget ? "stopped_budget" : "failed");
      return;
    }
    run.steps += 1;
    run.cost_usd = run.cost_usd === null || reply.costUsd === null ? null : run.cost_usd + reply.costUsd;
    run.messages.push(reply.message);
    save(run);
  }
}

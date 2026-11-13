// biome-ignore-all lint/style/useNamingConvention: OpenAI and spend-log fields stay snake_case
// The council's model gateway. It holds the provider key, so nothing else needs it. Every caller
// gets its own gateway key with a dollar budget, and every call is priced and written to the spend
// log. It speaks the OpenAI chat format: POST /v1/chat/completions with "model" set to a role
// (fast, smart, judge).

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isRole, price, provider, type Role } from "../../config/models";
import type { ChatMessage, ChatTool, ModelAnswer } from "./providers";
import { replay, tokens } from "./replay";

const PORT = Number(process.env.PORT ?? 7002);
const DIR = process.env.GATEWAY_DATA ?? "/data";
mkdirSync(DIR, { recursive: true });
const KEYS = `${DIR}/keys.json`;
const SPEND = `${DIR}/spend.jsonl`;
const PROVIDER = provider();

function readAdminKey(): string {
  const file = process.env.GATEWAY_ADMIN_KEY_FILE ?? "/run/secrets/gateway_admin_key";
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  if (process.env.GATEWAY_ADMIN_KEY) return process.env.GATEWAY_ADMIN_KEY;
  throw new Error(
    "The gateway has no admin key. Run `bun run world` first; it writes secrets/gateway_admin_key.",
  );
}
const adminKey = readAdminKey();

type Key = {
  key: string;
  name: string;
  max_budget_usd: number | null;
  spent_usd: number;
  blocked?: boolean;
};
type Caller = Key | "admin";
type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  max_tokens?: number;
};

const loadKeys = (): Key[] => (existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : []);
const saveKeys = (keys: Key[]) => writeFileSync(KEYS, JSON.stringify(keys, null, 2));
const json = (body: unknown, status = 200) => Response.json(body, { status });
const gatewayError = (status: number, type: string, message: string) =>
  json({ error: { type, message } }, status);

// The kill switch: when on, every model call is refused.
let killed = false;

function whoIsCalling(request: Request): Caller | null {
  const authorization = request.headers.get("authorization") ?? "";
  const key = authorization.replace(/^Bearer\s+/i, "");
  if (key && key === adminKey) return "admin";
  return loadKeys().find((known) => known.key === key) ?? null;
}

async function addKey(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    name: string;
    max_budget_usd?: number | null;
    key?: string;
  };
  // A key with the same name is replaced, so registering again starts its spend at zero.
  const keys = loadKeys().filter((known) => known.name !== body.name);
  const added: Key = {
    key: body.key ?? `hdc-gw-${randomBytes(18).toString("hex")}`,
    name: body.name,
    max_budget_usd: body.max_budget_usd ?? null,
    spent_usd: 0,
  };
  keys.push(added);
  saveKeys(keys);
  return json(added);
}

async function setBudget(request: Request): Promise<Response> {
  const body = (await request.json()) as { name: string; max_budget_usd: number | null };
  const keys = loadKeys();
  const found = keys.find((known) => known.name === body.name);
  if (!found) return gatewayError(404, "not_found", `no key named ${body.name}`);
  found.max_budget_usd = body.max_budget_usd;
  saveKeys(keys);
  return json(found);
}

function listKeys(): Response {
  // Show only the start of each key, so the list is safe to print.
  const keys = loadKeys().map(({ key, ...rest }) => ({ ...rest, key: `${key.slice(0, 10)}...` }));
  return json(keys);
}

function spendLog(): Response {
  if (!existsSync(SPEND)) return json([]);
  const lines = readFileSync(SPEND, "utf8").trim().split("\n");
  return json(lines.filter(Boolean).map((line) => JSON.parse(line)));
}

function resetSpend(): Response {
  writeFileSync(SPEND, "");
  saveKeys(loadKeys().map((key) => ({ ...key, spent_usd: 0 })));
  killed = false;
  return json({ status: "reset" });
}

function setKillSwitch(switchedOn: boolean): Response {
  killed = switchedOn;
  return json({ killed });
}

const ADMIN_ROUTES: Record<string, (request: Request) => Response | Promise<Response>> = {
  "POST /admin/keys": addKey,
  "POST /admin/budget": setBudget,
  "GET /admin/keys": listKeys,
  "GET /admin/spend": spendLog,
  "POST /admin/reset": resetSpend,
  "POST /admin/kill": () => setKillSwitch(true),
  "POST /admin/revive": () => setKillSwitch(false),
};

function adminRoute(request: Request, url: URL, caller: Caller) {
  if (caller !== "admin")
    return gatewayError(403, "forbidden", "Only the admin key can manage keys.");
  const route = ADMIN_ROUTES[`${request.method} ${url.pathname}`];
  if (!route) return gatewayError(404, "not_found", "no such admin route");
  return route(request);
}

async function askModel(body: ChatRequest, role: Role): Promise<ModelAnswer> {
  if (PROVIDER === "replay") {
    const reply = replay(body.messages, body.tools);
    const toolCalls = reply.tool_calls;
    const sent = JSON.stringify(body.messages) + JSON.stringify(body.tools ?? []);
    return {
      content: reply.content,
      toolCalls,
      inputTokens: tokens(sent),
      outputTokens: tokens((reply.content ?? "") + JSON.stringify(toolCalls ?? [])),
    };
  }
  const { callProvider } = await import("./providers");
  return callProvider(PROVIDER, role, body.messages, {
    tools: body.tools,
    maxTokens: body.max_tokens,
  });
}

function overBudget(caller: Caller): boolean {
  if (caller === "admin" || caller.max_budget_usd === null) return false;
  return caller.spent_usd >= caller.max_budget_usd;
}

function addSpend(caller: Caller, cost: number | null) {
  if (caller === "admin" || cost === null) return;
  const keys = loadKeys();
  const found = keys.find((known) => known.name === caller.name);
  if (!found) return;
  found.spent_usd = Number((found.spent_usd + cost).toFixed(8));
  saveKeys(keys);
}

type SpendEntry = {
  id: string;
  keyName: string;
  role: Role;
  runId: string | null;
  answer: ModelAnswer;
  cost: number | null;
};

function writeSpendLine(entry: SpendEntry) {
  const line = {
    at: new Date().toISOString(),
    id: entry.id,
    key: entry.keyName,
    role: entry.role,
    provider: PROVIDER,
    run_id: entry.runId,
    input_tokens: entry.answer.inputTokens,
    output_tokens: entry.answer.outputTokens,
    cost_usd: entry.cost,
  };
  appendFileSync(SPEND, `${JSON.stringify(line)}\n`);
}

function chatCompletion(id: string, role: Role, answer: ModelAnswer, cost: number | null) {
  const { content, toolCalls, inputTokens, outputTokens } = answer;
  const choice = {
    index: 0,
    finish_reason: toolCalls ? "tool_calls" : "stop",
    message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
  };
  const completion = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: role,
    choices: [choice],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cost_usd: cost,
    },
  };
  const costHeader = cost === null ? "unknown" : String(cost);
  return Response.json(completion, { headers: { "x-gateway-cost-usd": costHeader } });
}

async function chat(request: Request, caller: Caller): Promise<Response> {
  if (killed) {
    const message = "The gateway kill switch is on. No model calls are allowed.";
    return gatewayError(503, "kill_switch", message);
  }
  const body = (await request.json()) as ChatRequest;
  if (!isRole(body.model)) {
    const message = `"${body.model}" is not a role. Ask for fast, smart or judge.`;
    return gatewayError(400, "unknown_role", message);
  }
  const role = body.model;
  const keyName = caller === "admin" ? "admin" : caller.name;
  if (caller !== "admin" && overBudget(caller)) {
    const message = `The key "${keyName}" has spent its budget of $${caller.max_budget_usd}.`;
    return gatewayError(429, "budget_exceeded", message);
  }
  let answer: ModelAnswer;
  try {
    answer = await askModel(body, role);
  } catch (error) {
    return gatewayError(502, "model_error", (error as Error).message);
  }
  const cost = price(PROVIDER, role, answer.inputTokens, answer.outputTokens);
  addSpend(caller, cost);
  const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
  const runId = request.headers.get("x-run-id");
  writeSpendLine({ id, keyName, role, runId, answer, cost });
  return chatCompletion(id, role, answer, cost);
}

async function answerRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ status: "ok", provider: PROVIDER, killed });
  const caller = whoIsCalling(request);
  if (!caller) {
    const message = "That gateway key is not known. Use the key the world gave your service.";
    return gatewayError(401, "invalid_key", message);
  }
  if (url.pathname.startsWith("/admin/")) return adminRoute(request, url, caller);
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    return chat(request, caller);
  }
  return gatewayError(404, "not_found", "no such route");
}

Bun.serve({ port: PORT, idleTimeout: 120, fetch: answerRequest });
console.log(`gateway listening on ${PORT}, provider ${PROVIDER}`);

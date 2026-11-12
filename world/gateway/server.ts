// The council's model gateway. It holds the provider key, so nothing else needs it. Every caller gets its own
// gateway key with a dollar budget, and every call is priced and written to the spend log.
// It speaks the OpenAI chat format: POST /v1/chat/completions with "model" set to a role (fast, smart, judge).

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isRole, price, provider, type Role } from "../../config/models";
import { replay, tokens } from "./replay";

const PORT = Number(process.env.PORT ?? 7002);
const DIR = process.env.GATEWAY_DATA ?? "/data";
mkdirSync(DIR, { recursive: true });
const KEYS = `${DIR}/keys.json`;
const SPEND = `${DIR}/spend.jsonl`;
const PROVIDER = provider();

const adminKey = (() => {
  const f = process.env.GATEWAY_ADMIN_KEY_FILE ?? "/run/secrets/gateway_admin_key";
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  if (process.env.GATEWAY_ADMIN_KEY) return process.env.GATEWAY_ADMIN_KEY;
  throw new Error(
    "The gateway has no admin key. Run `bun run world` first; it writes secrets/gateway_admin_key.",
  );
})();

type Key = {
  key: string;
  name: string;
  max_budget_usd: number | null;
  spent_usd: number;
  blocked?: boolean;
};
const load = (): Key[] => (existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : []);
const save = (k: Key[]) => writeFileSync(KEYS, JSON.stringify(k, null, 2));
const json = (b: unknown, status = 200) => Response.json(b, { status });
const err = (status: number, type: string, message: string) =>
  json({ error: { type, message } }, status);
let killed = false; // the kill switch: when on, every model call is refused

function who(req: Request): Key | "admin" | null {
  const k = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (k && k === adminKey) return "admin";
  return load().find((x) => x.key === k) ?? null;
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ status: "ok", provider: PROVIDER, killed });
    const caller = who(req);
    if (!caller)
      return err(
        401,
        "invalid_key",
        "That gateway key is not known. Use the key the world gave your service.",
      );

    if (url.pathname.startsWith("/admin/")) {
      if (caller !== "admin") return err(403, "forbidden", "Only the admin key can manage keys.");
      if (req.method === "POST" && url.pathname === "/admin/keys") {
        const b = (await req.json()) as {
          name: string;
          max_budget_usd?: number | null;
          key?: string;
        };
        const keys = load().filter((k) => k.name !== b.name);
        const k: Key = {
          key: b.key ?? `hdc-gw-${randomBytes(18).toString("hex")}`,
          name: b.name,
          max_budget_usd: b.max_budget_usd ?? null,
          spent_usd: 0,
        };
        keys.push(k);
        save(keys);
        return json(k);
      }
      if (req.method === "POST" && url.pathname === "/admin/budget") {
        const b = (await req.json()) as { name: string; max_budget_usd: number | null };
        const keys = load();
        const k = keys.find((x) => x.name === b.name);
        if (!k) return err(404, "not_found", `no key named ${b.name}`);
        k.max_budget_usd = b.max_budget_usd;
        save(keys);
        return json(k);
      }
      if (req.method === "GET" && url.pathname === "/admin/keys")
        return json(load().map(({ key, ...r }) => ({ ...r, key: key.slice(0, 10) + "..." })));
      if (req.method === "GET" && url.pathname === "/admin/spend")
        return json(
          existsSync(SPEND)
            ? readFileSync(SPEND, "utf8")
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l))
            : [],
        );
      if (req.method === "POST" && url.pathname === "/admin/reset") {
        writeFileSync(SPEND, "");
        save(load().map((k) => ({ ...k, spent_usd: 0 })));
        killed = false;
        return json({ status: "reset" });
      }
      if (req.method === "POST" && url.pathname === "/admin/kill") {
        killed = true;
        return json({ killed });
      }
      if (req.method === "POST" && url.pathname === "/admin/revive") {
        killed = false;
        return json({ killed });
      }
      return err(404, "not_found", "no such admin route");
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (killed)
        return err(
          503,
          "kill_switch",
          "The gateway kill switch is on. No model calls are allowed.",
        );
      const body = (await req.json()) as {
        model: string;
        messages: any[];
        tools?: any[];
        max_tokens?: number;
      };
      if (!isRole(body.model))
        return err(
          400,
          "unknown_role",
          `"${body.model}" is not a role. Ask for fast, smart or judge.`,
        );
      const role = body.model as Role;
      const name = caller === "admin" ? "admin" : caller.name;
      if (
        caller !== "admin" &&
        caller.max_budget_usd !== null &&
        caller.spent_usd >= caller.max_budget_usd
      )
        return err(
          429,
          "budget_exceeded",
          `The key "${name}" has spent its budget of $${caller.max_budget_usd}.`,
        );

      let content: string | null, toolCalls: any, inputTokens: number, outputTokens: number;
      try {
        if (PROVIDER === "replay") {
          ({ content, toolCalls } = replay(body.messages, body.tools));
          inputTokens = tokens(JSON.stringify(body.messages) + JSON.stringify(body.tools ?? []));
          outputTokens = tokens((content ?? "") + JSON.stringify(toolCalls ?? []));
        } else {
          const { callProvider } = await import("./providers");
          ({ content, toolCalls, inputTokens, outputTokens } = await callProvider(
            PROVIDER,
            role,
            body.messages,
            body.tools,
            body.max_tokens,
          ));
        }
      } catch (e) {
        return err(502, "model_error", (e as Error).message);
      }
      const cost = price(PROVIDER, role, inputTokens, outputTokens);
      if (caller !== "admin" && cost !== null) {
        const keys = load();
        const k = keys.find((x) => x.name === caller.name)!;
        k.spent_usd = Number((k.spent_usd + cost).toFixed(8));
        save(keys);
      }
      const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
      appendFileSync(
        SPEND,
        JSON.stringify({
          at: new Date().toISOString(),
          id,
          key: name,
          role,
          provider: PROVIDER,
          run_id: req.headers.get("x-run-id"),
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: cost,
        }) + "\n",
      );
      return Response.json(
        {
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: role,
          choices: [
            {
              index: 0,
              finish_reason: toolCalls ? "tool_calls" : "stop",
              message: {
                role: "assistant",
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
            },
          ],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cost_usd: cost,
          },
        },
        { headers: { "x-gateway-cost-usd": cost === null ? "unknown" : String(cost) } },
      );
    }
    return err(404, "not_found", "no such route");
  },
});
console.log(`gateway listening on ${PORT}, provider ${PROVIDER}`);

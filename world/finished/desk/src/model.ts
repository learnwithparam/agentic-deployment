// The only way the desk talks to a model: the council's gateway, in the OpenAI chat format.
// The desk asks for a role ("fast"), never a model id. The gateway decides which model plays it.
import { GATEWAY_URL, gatewayKey } from "./config";

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type Reply = {
  message: Message;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
};

export class GatewayError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
  ) {
    super(message);
  }
}

export async function chat(
  role: string,
  messages: Message[],
  tools: unknown[],
  runId: string,
): Promise<Reply> {
  const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayKey()}`,
      "content-type": "application/json",
      "x-run-id": runId,
    },
    body: JSON.stringify({ model: role, messages, tools }),
  });
  const body = (await r.json()) as any;
  if (!r.ok)
    throw new GatewayError(
      r.status,
      body?.error?.type ?? "model_error",
      body?.error?.message ?? `gateway answered ${r.status}`,
    );
  return {
    message: body.choices[0].message,
    costUsd: body.usage?.cost_usd ?? null,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

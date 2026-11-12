// biome-ignore-all lint/style/useNamingConvention: the OpenAI chat format names fields tool_calls
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

// What the gateway sends back: the model's message and its price, or an error.
type GatewayAnswer = {
  choices: { message: Message }[];
  usage?: { cost_usd?: number; prompt_tokens?: number; completion_tokens?: number };
  error?: { type?: string; message?: string };
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
  const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayKey()}`,
      "content-type": "application/json",
      // The gateway files the cost of this call under the run, so each run has a price.
      "x-run-id": runId,
    },
    body: JSON.stringify({ model: role, messages, tools }),
  });
  const answer = (await response.json()) as GatewayAnswer;
  if (!response.ok)
    throw new GatewayError(
      response.status,
      answer?.error?.type ?? "model_error",
      answer?.error?.message ?? `gateway answered ${response.status}`,
    );
  return {
    message: answer.choices[0].message,
    costUsd: answer.usage?.cost_usd ?? null,
    inputTokens: answer.usage?.prompt_tokens ?? 0,
    outputTokens: answer.usage?.completion_tokens ?? 0,
  };
}

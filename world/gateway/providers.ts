// biome-ignore-all lint/style/useNamingConvention: OpenAI chat fields stay snake_case (tool_calls)
// Real providers through the Vercel AI SDK. Loaded only when LLM_PROVIDER is not replay.
import type { AssistantModelMessage, LanguageModel, ModelMessage, ToolSet } from "ai";
import { KEY_ENV, MODEL_IDS, type Provider, type Role } from "../../config/models";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ChatTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};
type RealProvider = Exclude<Provider, "replay">;

/** What the gateway needs back from any model, real or replayed. */
export type ModelAnswer = {
  content: string | null;
  toolCalls: ToolCall[] | undefined;
  inputTokens: number;
  outputTokens: number;
};

async function languageModel(provider: RealProvider, role: Role, key: string) {
  const modelId = MODEL_IDS[provider][role];
  if (provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: key })(modelId);
  }
  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey: key })(modelId);
  }
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  return createOpenRouter({ apiKey: key }).chat(modelId) as LanguageModel;
}

function assistantMessage(message: ChatMessage, toolNames: Map<string, string>): ModelMessage {
  const parts: Exclude<AssistantModelMessage["content"], string> = [];
  if (message.content) parts.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    toolNames.set(call.id, call.function.name);
    parts.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.function.name,
      input: JSON.parse(call.function.arguments || "{}"),
    });
  }
  return { role: "assistant", content: parts };
}

function toolMessage(message: ChatMessage, toolNames: Map<string, string>): ModelMessage {
  const result = {
    type: "tool-result" as const,
    toolCallId: message.tool_call_id ?? "",
    toolName: toolNames.get(message.tool_call_id ?? "") ?? "tool",
    output: { type: "text" as const, value: message.content ?? "" },
  };
  return { role: "tool", content: [result] };
}

/** Turn OpenAI chat messages into the AI SDK's messages. */
function convertMessages(messages: ChatMessage[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    // AI SDK 7 takes the system prompt as "instructions", so system messages are skipped here.
    if (message.role === "user") converted.push({ role: "user", content: message.content ?? "" });
    if (message.role === "assistant") converted.push(assistantMessage(message, toolNames));
    if (message.role === "tool") converted.push(toolMessage(message, toolNames));
  }
  return converted;
}

async function toolSetFor(tools: ChatTool[]): Promise<ToolSet> {
  const { jsonSchema, tool } = await import("ai");
  const toolSet: ToolSet = {};
  for (const offered of tools) {
    const schema = offered.function.parameters ?? { type: "object", properties: {} };
    toolSet[offered.function.name] = tool({
      description: offered.function.description,
      inputSchema: jsonSchema(schema),
    });
  }
  return toolSet;
}

function missingKeyError(provider: RealProvider): Error {
  const message = `${KEY_ENV[provider]} is not set. Put it in .env and restart the world.`;
  return Object.assign(new Error(message), { code: "no_key" });
}

export async function callProvider(
  provider: RealProvider,
  role: Role,
  messages: ChatMessage[],
  options: { tools?: ChatTool[]; maxTokens?: number } = {},
): Promise<ModelAnswer> {
  const { tools = [], maxTokens = 1024 } = options;
  const key = process.env[KEY_ENV[provider]];
  if (!key) throw missingKeyError(provider);
  const { generateText } = await import("ai");
  const systemMessages = messages.filter((message) => message.role === "system");
  const instructions = systemMessages.map((message) => message.content ?? "").join("\n");
  const answer = await generateText({
    model: await languageModel(provider, role, key),
    instructions: instructions || undefined,
    messages: convertMessages(messages),
    tools: tools.length ? await toolSetFor(tools) : undefined,
    maxOutputTokens: maxTokens,
  });
  const toolCalls = answer.toolCalls.map((call) => ({
    id: call.toolCallId,
    type: "function" as const,
    function: { name: call.toolName, arguments: JSON.stringify(call.input) },
  }));
  return {
    content: answer.text || null,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    inputTokens: answer.usage.inputTokens ?? 0,
    outputTokens: answer.usage.outputTokens ?? 0,
  };
}

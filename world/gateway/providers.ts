// Real providers through the Vercel AI SDK. Loaded only when LLM_PROVIDER is not replay.
import { KEY_ENV, MODEL_IDS, type Provider, type Role } from "../../config/models";

type Msg = {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};
type Tool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

export async function callProvider(
  p: Exclude<Provider, "replay">,
  role: Role,
  messages: Msg[],
  tools: Tool[] = [],
  maxTokens = 1024,
) {
  const key = process.env[KEY_ENV[p]];
  if (!key)
    throw Object.assign(
      new Error(`${KEY_ENV[p]} is not set. Put it in .env and restart the world.`),
      { code: "no_key" },
    );
  const { generateText, jsonSchema, tool } = await import("ai");
  const id = MODEL_IDS[p][role];
  let model: any;
  if (p === "anthropic")
    model = (await import("@ai-sdk/anthropic")).createAnthropic({ apiKey: key })(id);
  else if (p === "openai")
    model = (await import("@ai-sdk/openai")).createOpenAI({ apiKey: key })(id);
  else
    model = (await import("@openrouter/ai-sdk-provider"))
      .createOpenRouter({ apiKey: key })
      .chat(id);

  const names = new Map<string, string>();
  const converted: any[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // AI SDK 7 takes the system prompt as "instructions"
    if (m.role === "user") converted.push({ role: "user", content: m.content ?? "" });
    else if (m.role === "assistant") {
      const parts: any[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) {
        names.set(c.id, c.function.name);
        parts.push({
          type: "tool-call",
          toolCallId: c.id,
          toolName: c.function.name,
          input: JSON.parse(c.function.arguments || "{}"),
        });
      }
      converted.push({ role: "assistant", content: parts });
    } else if (m.role === "tool") {
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id,
            toolName: names.get(m.tool_call_id ?? "") ?? "tool",
            output: { type: "text", value: m.content ?? "" },
          },
        ],
      });
    }
  }
  const toolSet: Record<string, any> = {};
  for (const t of tools)
    toolSet[t.function.name] = tool({
      description: t.function.description,
      inputSchema: jsonSchema((t.function.parameters ?? { type: "object", properties: {} }) as any),
    });
  const instructions =
    messages
      .filter((m) => m.role === "system")
      .map((m) => m.content ?? "")
      .join("\n") || undefined;
  const r = await generateText({
    model,
    instructions,
    messages: converted,
    tools: tools.length ? toolSet : undefined,
    maxOutputTokens: maxTokens,
  });
  return {
    content: r.text || null,
    tool_calls: r.toolCalls.length
      ? r.toolCalls.map((c: any) => ({
          id: c.toolCallId,
          type: "function" as const,
          function: { name: c.toolName, arguments: JSON.stringify(c.input) },
        }))
      : undefined,
    input_tokens: r.usage.inputTokens ?? 0,
    output_tokens: r.usage.outputTokens ?? 0,
  };
}

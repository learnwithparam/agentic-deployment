// biome-ignore-all lint/style/useNamingConvention: OpenAI chat fields stay snake_case (tool_calls)
// The replay model. It speaks the OpenAI chat format and plays back the permit desk's script, so
// the course, its checks and CI run with no key and give the same answer every time. It reads only
// what a real model would see: the system prompt, the messages and the tool results.

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type Tool = { type: "function"; function: { name: string } };
export type Reply = { content: string | null; tool_calls?: ToolCall[] };

type ToolResult = { name: string; value: unknown };
type ChecklistItem = { item: string; label: string; present: boolean };
type ChecklistPage = { items?: ChecklistItem[]; more?: boolean; next_page?: number };
type ApplicationSeen = { description?: string; applicant?: { name?: string } };
type FeeSeen = { owed_gbp?: number };

// The rule a bad release adds to its prompt; the replay model obeys it, as a careless model would.
const BAD_FEE_RULE = /missing fee is fine/i;
const SIGN_OFF = "Harrowby District Council, permit desk";

function parseOrKeep(content: string | null | undefined): unknown {
  try {
    return JSON.parse(content ?? "");
  } catch {
    return content;
  }
}

/** Pair each tool result with the call that asked for it. */
function toolResults(messages: Message[]): ToolResult[] {
  const callNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) callNames.set(call.id, call.function.name);
  }
  const toolMessages = messages.filter((message) => message.role === "tool");
  return toolMessages.map((message) => ({
    name: callNames.get(message.tool_call_id ?? "") ?? "unknown",
    value: parseOrKeep(message.content),
  }));
}

type Script = { applicationId: string; offered: Set<string>; turn: number };

function callTool(script: Script, name: string, args: Record<string, unknown>): Reply {
  if (!script.offered.has(name)) {
    const finish = `to finish ${script.applicationId}, and it is not available.`;
    return { content: `I need the ${name} tool ${finish}` };
  }
  const call: ToolCall = {
    id: `call_${script.turn}_${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  return { content: null, tool_calls: [call] };
}

type Verdict = { ask: string[]; lines: string[]; lenient: boolean; owed: number };

function verdict(pages: ChecklistPage[], fee: FeeSeen, systemPrompt: string): Verdict {
  const allItems = pages.flatMap((page) => page.items ?? []);
  const missing = allItems.filter((item) => !item.present);
  const lenient = BAD_FEE_RULE.test(systemPrompt);
  const owed = Number(fee.owed_gbp ?? 0);
  const ask = missing.map((item) => item.item);
  const lines = missing.map((item) => `- ${item.label}`);
  if (owed > 0 && !lenient) {
    ask.push("fee");
    lines.push(`- The application fee of £${owed}`);
  }
  return { ask, lines, lenient, owed };
}

function letterText(id: string, application: ApplicationSeen, decided: Verdict): string {
  const name = application.applicant?.name ?? "applicant";
  const opening = `Dear ${name},\n\nThank you for application ${id} (${application.description}).`;
  if (decided.ask.length) {
    const request = `Before we can validate it, please send:\n${decided.lines.join("\n")}`;
    return `${opening} ${request}\n\n${SIGN_OFF}`;
  }
  const noFee = decided.lenient && decided.owed > 0 ? ", and no fee is needed" : "";
  const complete = `It has everything we need${noFee}. A planning officer will now check it.`;
  return `${opening} ${complete}\n\n${SIGN_OFF}`;
}

function finalAnswer(id: string, application: ApplicationSeen, decided: Verdict): Reply {
  const name = application.applicant?.name ?? "applicant";
  const checked = `I checked ${id} against the council's checklist.`;
  if (decided.ask.length) {
    const asked = `I wrote to ${name} asking for: ${decided.ask.join(", ")}.`;
    return { content: `${checked} It is not valid yet. ${asked}` };
  }
  return {
    content: `${checked} It has everything it needs, so it now waits for a planning officer.`,
  };
}

/** The arguments for the next checklist page, or undefined once the last page has been read. */
function nextChecklistPage(pages: ChecklistPage[]): { page?: number } | undefined {
  const lastPage = pages.at(-1);
  if (!lastPage) return { page: 1 };
  if (lastPage.more) return { page: lastPage.next_page };
  return undefined;
}

function systemPromptOf(messages: Message[]): string {
  const systemMessages = messages.filter((message) => message.role === "system");
  return systemMessages.map((message) => message.content ?? "").join("\n");
}

export function replay(messages: Message[], tools: Tool[] = []): Reply {
  const userText = messages.find((message) => message.role === "user")?.content ?? "";
  const applicationId = userText.match(/HDC-\d{4}-\d{4}/)?.[0];
  if (!applicationId) {
    return { content: "Please give me an application number, for example HDC-2026-0142." };
  }
  const script: Script = {
    applicationId,
    offered: new Set(tools.map((tool) => tool.function.name)),
    turn: messages.filter((message) => message.role === "assistant").length + 1,
  };
  const results = toolResults(messages);
  const latest = (name: string) => results.filter((result) => result.name === name).at(-1)?.value;

  // Each step asks for the next tool until the script has everything it needs.
  const application = latest("read_application") as ApplicationSeen | undefined;
  if (!application) return callTool(script, "read_application", { application_id: applicationId });
  const pageResults = results.filter((result) => result.name === "check_checklist");
  const pages = pageResults.map((result) => result.value as ChecklistPage);
  const nextPage = nextChecklistPage(pages);
  if (nextPage) {
    return callTool(script, "check_checklist", { application_id: applicationId, ...nextPage });
  }
  const fee = latest("calculate_fee") as FeeSeen | undefined;
  if (!fee) return callTool(script, "calculate_fee", { application_id: applicationId });

  const decided = verdict(pages, fee, systemPromptOf(messages));
  if (latest("write_decision")) return finalAnswer(applicationId, application, decided);
  return callTool(script, "write_decision", {
    application_id: applicationId,
    status: decided.ask.length ? "invalid_missing_items" : "valid_awaiting_officer",
    missing_items: decided.ask,
    letter: letterText(applicationId, application, decided),
  });
}

/** Token counts the way a tokenizer roughly would: about four characters a token. */
export const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

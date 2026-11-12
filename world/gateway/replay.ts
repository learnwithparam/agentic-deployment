// The replay model. It speaks the OpenAI chat format and plays back the permit desk's script, so the course,
// its checks and CI run with no key and give the same answer every time. It reads only what a real model
// would see: the system prompt, the messages and the tool results.

type Msg = {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};
type Tool = { type: "function"; function: { name: string } };
export type Reply = { content: string | null; tool_calls?: Msg["tool_calls"] };

const BAD_FEE_RULE = /missing fee is fine/i;

export function replay(messages: Msg[], tools: Tool[] = []): Reply {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .join("\n");
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const id = user.match(/HDC-\d{4}-\d{4}/)?.[0];
  const offered = new Set(tools.map((t) => t.function.name));
  if (!id) return { content: "Please give me an application number, for example HDC-2026-0142." };

  // Pair each tool result with the call that asked for it.
  const names = new Map<string, string>();
  for (const m of messages) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  const results: { name: string; value: any }[] = [];
  for (const m of messages)
    if (m.role === "tool") {
      let value: any = m.content;
      try {
        value = JSON.parse(m.content ?? "");
      } catch {}
      results.push({ name: names.get(m.tool_call_id ?? "") ?? "unknown", value });
    }
  const last = (n: string) => results.filter((r) => r.name === n).at(-1)?.value;
  const turn = messages.filter((m) => m.role === "assistant").length + 1;
  const call = (name: string, args: Record<string, unknown>): Reply => {
    if (!offered.has(name))
      return { content: `I need the ${name} tool to finish ${id}, and it is not available.` };
    return {
      content: null,
      tool_calls: [
        {
          id: `call_${turn}_${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    };
  };

  const app = last("read_application");
  if (!app) return call("read_application", { application_id: id });
  const pages = results.filter((r) => r.name === "check_checklist").map((r) => r.value);
  const lastPage = pages.at(-1);
  if (!lastPage || lastPage.more)
    return call("check_checklist", { application_id: id, page: lastPage ? lastPage.next_page : 1 });
  const fee = last("calculate_fee");
  if (!fee) return call("calculate_fee", { application_id: id });

  const missing: { item: string; label: string }[] = pages
    .flatMap((p) => p.items ?? [])
    .filter((i: any) => !i.present);
  const lenient = BAD_FEE_RULE.test(system);
  const owed = Number(fee.owed_gbp ?? 0);
  const ask = missing.map((m) => m.item);
  const lines = missing.map((m) => `- ${m.label}`);
  if (owed > 0 && !lenient) {
    ask.push("fee");
    lines.push(`- The application fee of £${owed}`);
  }
  const status = ask.length ? "invalid_missing_items" : "valid_awaiting_officer";
  const name = app.applicant?.name ?? "applicant";
  const letter = ask.length
    ? `Dear ${name},\n\nThank you for application ${id} (${app.description}). Before we can validate it, please send:\n${lines.join("\n")}\n\nHarrowby District Council, permit desk`
    : `Dear ${name},\n\nThank you for application ${id} (${app.description}). It has everything we need${lenient && owed > 0 ? ", and no fee is needed" : ""}. A planning officer will now check it.\n\nHarrowby District Council, permit desk`;

  const wrote = last("write_decision");
  if (!wrote)
    return call("write_decision", { application_id: id, status, missing_items: ask, letter });
  return {
    content: ask.length
      ? `I checked ${id} against the council's checklist. It is not valid yet. I wrote to ${name} asking for: ${ask.join(", ")}.`
      : `I checked ${id} against the council's checklist. It has everything it needs, so it now waits for a planning officer.`,
  };
}

/** Token counts the way a tokenizer roughly would: about four characters a token. */
export const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

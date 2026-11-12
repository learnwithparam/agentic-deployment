// The agent's four tools. Each one calls the permit register, the council's system of record.
import { REGISTER_URL, currentRelease } from "./config";

export const TOOLS = [
  { type: "function", function: { name: "read_application", description: "Read a permit application: its type, proposal, address and attachments.",
    parameters: { type: "object", properties: { application_id: { type: "string" } }, required: ["application_id"] } } },
  { type: "function", function: { name: "check_checklist", description: "Read one page of the council's checklist for this application, with each item marked present or not. If more is true, read next_page too.",
    parameters: { type: "object", properties: { application_id: { type: "string" }, page: { type: "integer", minimum: 1 } }, required: ["application_id", "page"] } } },
  { type: "function", function: { name: "calculate_fee", description: "Work out the fee due, the fee paid and what is still owed, in pounds.",
    parameters: { type: "object", properties: { application_id: { type: "string" } }, required: ["application_id"] } } },
  { type: "function", function: { name: "write_decision", description: "Write the validation decision to the register and send the resident one letter.",
    parameters: { type: "object", properties: {
      application_id: { type: "string" },
      status: { type: "string", enum: ["invalid_missing_items", "valid_awaiting_officer"] },
      missing_items: { type: "array", items: { type: "string" } },
      letter: { type: "string", description: "The letter to the resident, in plain English." },
    }, required: ["application_id", "status", "missing_items", "letter"] } } },
];

async function register(path: string, init?: RequestInit & { key?: string }) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-actor": "permit-desk", "x-release": currentRelease().id };
  if (init?.key) headers["idempotency-key"] = init.key;
  const r = await fetch(`${REGISTER_URL}${path}`, { ...init, headers });
  const body = await r.json();
  if (!r.ok) return { error: (body as any).error ?? `register answered ${r.status}` };
  return body;
}

export async function runTool(name: string, args: any, runId: string): Promise<unknown> {
  const id = encodeURIComponent(String(args.application_id ?? ""));
  switch (name) {
    case "read_application": return register(`/applications/${id}`);
    case "check_checklist": return register(`/applications/${id}/checklist?page=${Number(args.page ?? 1)}`);
    case "calculate_fee": return register(`/applications/${id}/fee`);
    case "write_decision": {
      const d = await register(`/applications/${id}/decision`, { method: "POST", body: JSON.stringify({ status: args.status, missing_items: args.missing_items }), key: `${runId}:decision` });
      if ((d as any).error) return d;
      const l = await register(`/applications/${id}/letters`, { method: "POST", body: JSON.stringify({ kind: "validation", body: args.letter }), key: `${runId}:letter` });
      return { ...(d as object), letter: l };
    }
    default: return { error: `there is no tool called ${name}` };
  }
}

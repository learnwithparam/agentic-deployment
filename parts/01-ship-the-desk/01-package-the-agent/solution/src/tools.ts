// biome-ignore-all lint/style/useNamingConvention: register JSON uses names like application_id
// The agent's four tools. Each one calls the permit register, the council's system of record.
import { REGISTER_URL, release } from "./config";

// The tools as the model sees them: a name, what the tool does, and the arguments it takes.
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_application",
      description: "Read a permit application: its type, proposal, address and attachments.",
      parameters: {
        type: "object",
        properties: { application_id: { type: "string" } },
        required: ["application_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_checklist",
      description:
        "Read one page of the council's checklist for this application, " +
        "with each item marked present or not. If more is true, read next_page too.",
      parameters: {
        type: "object",
        properties: { application_id: { type: "string" }, page: { type: "integer", minimum: 1 } },
        required: ["application_id", "page"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate_fee",
      description: "Work out the fee due, the fee paid and what is still owed, in pounds.",
      parameters: {
        type: "object",
        properties: { application_id: { type: "string" } },
        required: ["application_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_decision",
      description:
        "Write the validation decision to the register and send the resident one letter.",
      parameters: {
        type: "object",
        properties: {
          application_id: { type: "string" },
          status: { type: "string", enum: ["invalid_missing_items", "valid_awaiting_officer"] },
          missing_items: { type: "array", items: { type: "string" } },
          letter: { type: "string", description: "The letter to the resident, in plain English." },
        },
        required: ["application_id", "status", "missing_items", "letter"],
      },
    },
  },
];

// The arguments the model sends. It can send anything, so nothing here is trusted to be there.
type ToolArguments = {
  application_id?: unknown;
  page?: unknown;
  status?: unknown;
  missing_items?: unknown;
  letter?: unknown;
};

// What the register answers: the record that was asked for, or an error.
type RegisterAnswer = { error?: unknown; [field: string]: unknown };

// Every write carries an idempotency key, so a retried run never writes the same thing twice.
type RegisterRequest = RequestInit & { idempotencyKey?: string };

async function callRegister(path: string, request?: RegisterRequest): Promise<RegisterAnswer> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-actor": "permit-desk",
    "x-release": release.id,
  };
  if (request?.idempotencyKey) headers["idempotency-key"] = request.idempotencyKey;
  const response = await fetch(`${REGISTER_URL}${path}`, { ...request, headers });
  const answer = (await response.json()) as RegisterAnswer;
  // The model reads errors as text, so it can try again or explain the problem.
  if (!response.ok) return { error: answer.error ?? `register answered ${response.status}` };
  return answer;
}

// Record the decision first. Only send the resident a letter once the decision is saved.
async function writeDecision(applicationPath: string, toolArguments: ToolArguments, runId: string) {
  const decision = await callRegister(`${applicationPath}/decision`, {
    method: "POST",
    body: JSON.stringify({
      status: toolArguments.status,
      missing_items: toolArguments.missing_items,
    }),
    idempotencyKey: `${runId}:decision`,
  });
  if (decision.error) return decision;
  const letter = await callRegister(`${applicationPath}/letters`, {
    method: "POST",
    body: JSON.stringify({ kind: "validation", body: toolArguments.letter }),
    idempotencyKey: `${runId}:letter`,
  });
  return { ...decision, letter };
}

export async function runTool(
  name: string,
  toolArguments: ToolArguments,
  runId: string,
): Promise<unknown> {
  const applicationId = encodeURIComponent(String(toolArguments.application_id ?? ""));
  const applicationPath = `/applications/${applicationId}`;
  switch (name) {
    case "read_application":
      return callRegister(applicationPath);
    case "check_checklist":
      return callRegister(`${applicationPath}/checklist?page=${Number(toolArguments.page ?? 1)}`);
    case "calculate_fee":
      return callRegister(`${applicationPath}/fee`);
    case "write_decision":
      return writeDecision(applicationPath, toolArguments, runId);
    default:
      return { error: `there is no tool called ${name}` };
  }
}

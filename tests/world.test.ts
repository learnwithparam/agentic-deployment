// biome-ignore-all lint/style/useNamingConvention: JSON fields stay snake_case, like tool_calls
// Unit tests for the world's pure parts: the council's rules and the replay model.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { replay } from "../world/gateway/replay";
import { applications, expected } from "../world/register/rules";

type Message = Parameters<typeof replay>[0][number];

function applicationWithId(id: string) {
  const application = applications().find((candidate) => candidate.id === id);
  if (!application) throw new Error(`no application ${id} in the world's data`);
  return application;
}
const tools = ["read_application", "check_checklist", "calculate_fee", "write_decision"].map(
  (name) => ({ type: "function" as const, function: { name } }),
);

test("the world has 40 applications", () => expect(applications().length).toBe(40));

test("HDC-2026-0142 owes the whole change of use fee", () => {
  expect(expected(applicationWithId("HDC-2026-0142"))).toEqual({
    status: "invalid_missing_items",
    missing: ["fee"],
    fee_owed_gbp: 578,
  });
});

test("replay starts by reading the application", () => {
  const reply = replay(
    [
      { role: "system", content: "x" },
      { role: "user", content: "Validate application HDC-2026-0142." },
    ],
    tools,
  );
  expect(reply.tool_calls?.[0].function.name).toBe("read_application");
});

function decide(prompt: string) {
  const messages: Message[] = [
    { role: "system", content: prompt },
    { role: "user", content: "Validate application HDC-2026-0142." },
  ];
  const results: Record<string, unknown> = {
    read_application: {
      id: "HDC-2026-0142",
      description: "Change of use",
      applicant: { name: "Ines Fenwick" },
    },
    check_checklist: { items: [{ item: "application_form", present: true }], more: false },
    calculate_fee: { owed_gbp: 578 },
  };
  for (let i = 0; i < 5; i++) {
    const reply = replay(messages, tools);
    const call = reply.tool_calls?.[0];
    if (!call) return null;
    if (call.function.name === "write_decision") return JSON.parse(call.function.arguments);
    messages.push({ role: "assistant", content: null, tool_calls: reply.tool_calls });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(results[call.function.name]),
    });
  }
  return null;
}

test("release v1 asks for the fee; release v2 says it is not needed", () => {
  const firstPrompt = JSON.parse(readFileSync("world/releases/v1.json", "utf8")).prompt;
  const secondPrompt = JSON.parse(readFileSync("world/releases/v2.json", "utf8")).prompt;
  expect(decide(firstPrompt)).toMatchObject({
    status: "invalid_missing_items",
    missing_items: ["fee"],
  });
  expect(decide(secondPrompt)).toMatchObject({
    status: "valid_awaiting_officer",
    missing_items: [],
  });
});

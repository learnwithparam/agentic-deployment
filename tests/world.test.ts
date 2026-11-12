// Unit tests for the world's pure parts: the council's rules and the replay model.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { replay } from "../world/gateway/replay";
import { applications, expected } from "../world/register/rules";

const app = (id: string) => applications().find((a) => a.id === id)!;
const tools = ["read_application", "check_checklist", "calculate_fee", "write_decision"].map(
  (name) => ({ type: "function" as const, function: { name } }),
);

test("the world has 40 applications", () => expect(applications().length).toBe(40));

test("HDC-2026-0142 owes the whole change of use fee", () => {
  expect(expected(app("HDC-2026-0142"))).toEqual({
    status: "invalid_missing_items",
    missing: ["fee"],
    fee_owed_gbp: 578,
  });
});

test("replay starts by reading the application", () => {
  const r = replay(
    [
      { role: "system", content: "x" },
      { role: "user", content: "Validate application HDC-2026-0142." },
    ],
    tools,
  );
  expect(r.tool_calls?.[0].function.name).toBe("read_application");
});

function decide(prompt: string) {
  const msgs: any[] = [
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
    const r = replay(msgs, tools);
    const c = r.tool_calls?.[0];
    if (!c) return null;
    if (c.function.name === "write_decision") return JSON.parse(c.function.arguments);
    msgs.push({ role: "assistant", content: null, tool_calls: r.tool_calls });
    msgs.push({
      role: "tool",
      tool_call_id: c.id,
      content: JSON.stringify(results[c.function.name]),
    });
  }
  return null;
}

test("release v1 asks for the fee; release v2 says it is not needed", () => {
  const v1 = JSON.parse(readFileSync("world/releases/v1.json", "utf8")).prompt;
  const v2 = JSON.parse(readFileSync("world/releases/v2.json", "utf8")).prompt;
  expect(decide(v1)).toMatchObject({ status: "invalid_missing_items", missing_items: ["fee"] });
  expect(decide(v2)).toMatchObject({ status: "valid_awaiting_officer", missing_items: [] });
});

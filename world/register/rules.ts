// The council's validation rules, written as code. The register uses them to judge every decision the agent
// writes, and the checks use them as the truth. Never imported by the learner's agent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DATA = process.env.WORLD_DATA ?? join(import.meta.dir, "..", "data");

export type Attachment = { item: string; file: string; note?: string };
export type Application = {
  id: string;
  type: string;
  description: string;
  address: string;
  applicant: { name: string; email: string; phone: string };
  fee_paid_gbp: number;
  attachments: Attachment[];
  planted?: string;
};
export type Checklist = {
  types: Record<string, { label: string; fee_gbp: number; required: string[] }>;
  items: Record<string, string>;
};

export const checklist = (): Checklist =>
  JSON.parse(readFileSync(join(DATA, "checklist.json"), "utf8"));

export function applications(): Application[] {
  const dir = join(DATA, "applications");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

export function missingItems(app: Application, c = checklist()): string[] {
  const have = new Set(app.attachments.map((a) => a.item));
  return (c.types[app.type]?.required ?? []).filter((i) => !have.has(i));
}

export function feeOwed(app: Application, c = checklist()): number {
  return Math.max(0, (c.types[app.type]?.fee_gbp ?? 0) - app.fee_paid_gbp);
}

export type Expected = {
  status: "invalid_missing_items" | "valid_awaiting_officer";
  missing: string[];
  fee_owed_gbp: number;
};

/** What a correct validation of this application says. */
export function expected(app: Application, c = checklist()): Expected {
  const missing = missingItems(app, c);
  const owed = feeOwed(app, c);
  const all = owed > 0 ? [...missing, "fee"] : missing;
  return {
    status: all.length ? "invalid_missing_items" : "valid_awaiting_officer",
    missing: all,
    fee_owed_gbp: owed,
  };
}

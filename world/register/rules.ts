// biome-ignore-all lint/style/useNamingConvention: JSON fields stay snake_case, like fee_paid_gbp
// The council's validation rules, written as code. The register uses them to judge every decision
// the agent writes, and the checks use them as the truth. Never imported by the learner's agent.
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
  const folder = join(DATA, "applications");
  const files = readdirSync(folder).filter((file) => file.endsWith(".json"));
  files.sort();
  return files.map((file) => JSON.parse(readFileSync(join(folder, file), "utf8")));
}

export function missingItems(application: Application, rules = checklist()): string[] {
  const attached = new Set(application.attachments.map((attachment) => attachment.item));
  const required = rules.types[application.type]?.required ?? [];
  return required.filter((item) => !attached.has(item));
}

export function feeOwed(application: Application, rules = checklist()): number {
  const feeDue = rules.types[application.type]?.fee_gbp ?? 0;
  return Math.max(0, feeDue - application.fee_paid_gbp);
}

export type Expected = {
  status: "invalid_missing_items" | "valid_awaiting_officer";
  missing: string[];
  fee_owed_gbp: number;
};

/** What a correct validation of this application says. */
export function expected(application: Application, rules = checklist()): Expected {
  const missing = missingItems(application, rules);
  const owed = feeOwed(application, rules);
  const everythingMissing = owed > 0 ? [...missing, "fee"] : missing;
  return {
    status: everythingMissing.length ? "invalid_missing_items" : "valid_awaiting_officer",
    missing: everythingMissing,
    fee_owed_gbp: owed,
  };
}

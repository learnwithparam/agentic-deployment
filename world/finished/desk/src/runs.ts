// The run journal: every run's conversation is saved after each step, so a run killed half way can finish
// after a restart without calling the model again for the steps it already did.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config";
import type { Message } from "./model";

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(`${DATA_DIR}/runs.db`, { create: true });
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, application_id TEXT, release_id TEXT,
  status TEXT, steps INTEGER, cost_usd REAL, cost_known INTEGER, messages TEXT, updated TEXT)`);

export type Run = {
  run_id: string;
  application_id: string;
  release_id: string;
  status: string;
  steps: number;
  cost_usd: number | null;
  messages: Message[];
};

export function save(r: Run) {
  db.run(`INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?)`, [
    r.run_id,
    r.application_id,
    r.release_id,
    r.status,
    r.steps,
    r.cost_usd ?? 0,
    r.cost_usd === null ? 0 : 1,
    JSON.stringify(r.messages),
    new Date().toISOString(),
  ]);
}
const toRun = (x: any): Run => ({
  ...x,
  cost_usd: x.cost_known ? x.cost_usd : null,
  messages: JSON.parse(x.messages),
});
export const get = (id: string): Run | null => {
  const x = db.query("SELECT * FROM runs WHERE run_id = ?").get(id);
  return x ? toRun(x) : null;
};
export const unfinished = (): Run[] =>
  db.query("SELECT * FROM runs WHERE status = 'running'").all().map(toRun);

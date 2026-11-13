// biome-ignore-all lint/style/useNamingConvention: a run's saved fields use names like run_id
// The run journal: every run's conversation is saved after each step, so a run killed half way
// can finish after a restart without calling the model again for the steps it already did.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config";
import type { Message } from "./model";

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(`${DATA_DIR}/runs.db`, { create: true });
// WAL lets the desk read runs while it writes one.
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY,
  application_id TEXT, release_id TEXT, status TEXT, steps INTEGER, cost_usd REAL,
  cost_known INTEGER, messages TEXT, updated TEXT)`);

export type Run = {
  run_id: string;
  application_id: string;
  release_id: string;
  status: string;
  steps: number;
  cost_usd: number | null;
  messages: Message[];
};

// A run as SQLite stores it: an unknown cost is saved as 0 with cost_known 0,
// and the conversation as JSON text.
type RunRow = Omit<Run, "cost_usd" | "messages"> & {
  cost_usd: number;
  cost_known: number;
  messages: string;
};

export function save(run: Run) {
  db.run(`INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?)`, [
    run.run_id,
    run.application_id,
    run.release_id,
    run.status,
    run.steps,
    run.cost_usd ?? 0,
    run.cost_usd === null ? 0 : 1,
    JSON.stringify(run.messages),
    new Date().toISOString(),
  ]);
}

function runFromRow(row: RunRow): Run {
  return {
    ...row,
    cost_usd: row.cost_known ? row.cost_usd : null,
    messages: JSON.parse(row.messages),
  };
}

export function get(id: string): Run | null {
  const row = db.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(id);
  return row ? runFromRow(row) : null;
}

export function unfinished(): Run[] {
  const rows = db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'running'").all();
  return rows.map(runFromRow);
}

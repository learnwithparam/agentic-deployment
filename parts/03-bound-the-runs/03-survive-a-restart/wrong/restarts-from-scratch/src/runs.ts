// biome-ignore-all lint/style/useNamingConvention: a run's fields keep wire names like run_id
// The run journal. Every run is saved to SQLite after each step: its status, its cost and the
// whole conversation. A run that was killed half way can then finish after a restart, without
// asking the model again for the steps it already did.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { Message } from "./model";

// Mount a volume here, so the journal outlives the container.
const DATA_FOLDER = process.env.DESK_DATA ?? "/data";
mkdirSync(DATA_FOLDER, { recursive: true });
const db = new Database(`${DATA_FOLDER}/runs.db`, { create: true });
db.exec(`CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, status TEXT NOT NULL, saved TEXT NOT NULL)`);

export type Run = {
  run_id: string;
  application_id: string;
  status: string;
  steps: number;
  // null means at least one model call came back without a price.
  cost_usd: number | null;
  messages: Message[];
};

export function newRun(applicationId: string, runId: string, prompt: string): Run {
  const run: Run = {
    run_id: runId,
    application_id: applicationId,
    status: "running",
    steps: 0,
    cost_usd: 0,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: `Validate application ${applicationId}.` },
    ],
  };
  save(run);
  return run;
}

/** Write the whole run, so the journal always holds its latest step. */
export function save(run: Run) {
  db.run("INSERT OR REPLACE INTO runs (run_id, status, saved) VALUES (?, ?, ?)", [
    run.run_id,
    run.status,
    JSON.stringify(run),
  ]);
}

type SavedRow = { saved: string };

export function findRun(runId: string): Run | undefined {
  const row = db.query<SavedRow, [string]>("SELECT saved FROM runs WHERE run_id = ?").get(runId);
  return row ? JSON.parse(row.saved) : undefined;
}

/** Runs that a restart cut short: they were still running when the desk stopped. */
export function unfinishedRuns(): Run[] {
  const rows = db.query<SavedRow, []>("SELECT saved FROM runs WHERE status = 'running'").all();
  return rows.map((row) => JSON.parse(row.saved));
}

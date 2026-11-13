// biome-ignore-all lint/style/useNamingConvention: a run's fields keep wire names like run_id
// What the desk remembers about each run: its status, how many model calls it made and its cost.
// It lives in memory, so a restart forgets every run. Part 3 saves runs to disk.

export type Run = {
  run_id: string;
  application_id: string;
  status: string;
  steps: number;
  // null means at least one model call came back without a price.
  cost_usd: number | null;
};

const runsById = new Map<string, Run>();

export function newRun(applicationId: string, runId: string): Run {
  const run: Run = {
    run_id: runId,
    application_id: applicationId,
    status: "running",
    steps: 0,
    cost_usd: 0,
  };
  runsById.set(runId, run);
  return run;
}

export function findRun(runId: string): Run | undefined {
  return runsById.get(runId);
}

// biome-ignore-all lint/style/useNamingConvention: run, spend and audit JSON use names like run_id
// survive-a-restart: `bun run chaos kill --desk` stops the desk after it writes a decision and
// before the letter is confirmed. After the restart the same run finishes, the register holds one
// decision and one letter, and the spend log shows no model step was asked twice.
import type { Rule } from "../scripts/verify";
import { runCommand } from "../world/cli/lib";
import { startDesk } from "./lib/desk";
import { dataField, postRun } from "./lib/sse";
import {
  audit,
  letters,
  type RegisterRecord,
  replayMode,
  resetWorld,
  type SpendRow,
  spend,
  URLS,
} from "./lib/world";

const KILLED = "HDC-2026-0142";

/** What the world shows after the kill: a clean run to compare with, and the killed run. */
type Aftermath = {
  cleanCalls: number;
  killedRunId: string;
  killedCalls: number;
  killedStatus: unknown;
  decisions: number;
  letters: number;
};

async function cleanRunId(): Promise<string> {
  const headers = { "x-resident-id": `restart-check-${Date.now()}` };
  const run = await postRun(KILLED, URLS.desk, headers);
  const doneEvent = run.events.find((event) => event.event === "done");
  return String((doneEvent && dataField(doneEvent, "run_id")) ?? "");
}

// The killed run is the first run in the spend log that is not the clean run.
function killedRunIdFrom(rows: SpendRow[], cleanId: string): string {
  const other = rows.find((row) => row.run_id && row.run_id !== cleanId);
  return other?.run_id ?? "";
}

async function runStatus(runId: string): Promise<unknown> {
  const response = await fetch(`${URLS.desk}/v1/runs/${runId}`).catch(() => null);
  if (!response?.ok) return null;
  const run = (await response.json()) as { status?: unknown };
  return run.status;
}

// A resumed run may still be finishing, so ask a few times before judging.
async function finalStatus(runId: string): Promise<unknown> {
  let status: unknown = null;
  for (let i = 0; i < 20; i++) {
    status = await runStatus(runId);
    if (status !== "running" && status !== null) return status;
    await Bun.sleep(500);
  }
  return status;
}

// Decisions for the application written after the last time it was reopened.
function decisionsSinceReopen(entries: RegisterRecord[]): number {
  const reopenedHere = (entry: RegisterRecord) => {
    const detail = entry.detail as { ids?: string[] } | undefined;
    return entry.action === "reopen" && Boolean(detail?.ids?.includes(KILLED));
  };
  const since = Math.max(0, ...entries.filter(reopenedHere).map((entry) => Number(entry.id)));
  const isDecision = (entry: RegisterRecord) =>
    Number(entry.id) > since && entry.application_id === KILLED && entry.action === "decision";
  return entries.filter(isDecision).length;
}

async function playKill(started: ReturnType<typeof startDesk>): Promise<Aftermath | null> {
  if (!(await started).ok || !(await replayMode())) return null;
  await resetWorld();
  const cleanId = await cleanRunId();
  const chaos = await runCommand(["bun", "run", "chaos", "kill", "--desk"]);
  if (chaos.code !== 0) return null;
  const killedRunId = killedRunIdFrom(await spend(), cleanId);
  const killedStatus = await finalStatus(killedRunId);
  const rows = await spend();
  const callsOf = (runId: string) => rows.filter((row) => row.run_id === runId).length;
  return {
    cleanCalls: callsOf(cleanId),
    killedRunId,
    killedCalls: callsOf(killedRunId),
    killedStatus,
    decisions: decisionsSinceReopen(await audit()),
    letters: (await letters(KILLED)).length,
  };
}

// The kill happens once per started desk, and every rule below reads what it left.
const kills = new WeakMap<object, Promise<Aftermath | null>>();
function aftermath(dir: string): Promise<Aftermath | null> {
  const started = startDesk(dir);
  let result = kills.get(started);
  if (!result) {
    result = playKill(started);
    kills.set(started, result);
  }
  return result;
}

export default [
  {
    says:
      "after bun run chaos kill --desk, the killed run finishes:" +
      " GET /v1/runs/:id says done (replay mode)",
    test: async (dir) => (await aftermath(dir))?.killedStatus === "done",
    tryNext:
      "Save each run to a journal (SQLite in /data) after every step. When the desk starts," +
      " run again every run whose status is still running.",
  },
  {
    says: "the register holds exactly one decision and one letter for HDC-2026-0142 after the kill",
    test: async (dir) => {
      const result = await aftermath(dir);
      return result?.decisions === 1 && result.letters === 1;
    },
    tryNext:
      "Build each idempotency key from the run id and the action, such as run_id:letter." +
      " A resumed run keeps its run id, so the register sees the same key" +
      " and sends no second letter.",
  },
  {
    says:
      "no finished model step was asked again: the killed run billed as many model calls" +
      " as a clean run of the same application",
    test: async (dir) => {
      const result = await aftermath(dir);
      return Boolean(result?.killedRunId) && result?.killedCalls === result?.cleanCalls;
    },
    tryNext:
      "Resume from the saved messages. If the last message asks for tools with no answer yet," +
      " run those tools first. Do not start the conversation again.",
  },
] satisfies Rule[];

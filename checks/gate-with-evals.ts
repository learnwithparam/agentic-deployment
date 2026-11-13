// gate-with-evals: `bun run gate <release>` passes the live release and the new one, blocks the
// bad one with the ids of the cases it gets wrong, and never writes to the register.

import type { Rule } from "../scripts/verify";
import { admin, composeEnv, runCommand } from "../world/cli/lib";
import { applications, audit, expected, type RegisterRecord, resetWorld, world } from "./lib/world";

const THREE_MINUTES_MS = 180_000;
type GateRun = { code: number; printed: string; seconds: number };
type GateRuns = { live: GateRun; bad: GateRun; friendly: GateRun; registerWrites: number };

// The 30 cases are HDC-2026-0140 to HDC-2026-0169. Release v2 gets wrong every one with a fee owed.
function casesV2GetsWrong(): string[] {
  const inGate = applications().filter(
    (application) => application.id >= "HDC-2026-0140" && application.id <= "HDC-2026-0169",
  );
  const feeOwed = inGate.filter((application) => expected(application).fee_owed_gbp > 0);
  return feeOwed.map((application) => application.id);
}

const wrongCaseList = casesV2GetsWrong().join(", ");

async function runGate(dir: string, release: string): Promise<GateRun> {
  // Each gate run starts with no spend, so three runs fit in the desk key's budget.
  await admin("/admin/reset", {});
  const startedAt = Date.now();
  const gate = runCommand(["bun", "run", "gate", release], { cwd: dir, env: composeEnv() });
  const tooSlow = Bun.sleep(THREE_MINUTES_MS).then(() => null);
  const finished = await Promise.race([gate, tooSlow]);
  const seconds = (Date.now() - startedAt) / 1000;
  if (!finished) return { code: -1, printed: "the gate ran for more than 3 minutes", seconds };
  return { code: finished.code, printed: finished.out + finished.err, seconds };
}

const isRegisterWrite = (entry: RegisterRecord) =>
  entry.action === "decision" || entry.action === "letter";

async function runEveryGate(dir: string): Promise<GateRuns> {
  await world();
  await resetWorld();
  const live = await runGate(dir, "v1");
  const friendly = await runGate(dir, "v3");
  const bad = await runGate(dir, "v2");
  const entries = await audit();
  const lastReset = entries.filter((entry) => entry.action === "reset").at(-1);
  const sinceReset = entries.filter((entry) => Number(entry.id) > Number(lastReset?.id ?? 0));
  return { live, bad, friendly, registerWrites: sinceReset.filter(isRegisterWrite).length };
}

// The gates run once per folder, and every rule below reads the same results.
const runsByFolder = new Map<string, Promise<GateRuns>>();
function gateRuns(dir: string): Promise<GateRuns> {
  let runs = runsByFolder.get(dir);
  if (!runs) {
    runs = runEveryGate(dir);
    runsByFolder.set(dir, runs);
  }
  return runs;
}

/** The application ids on the gate's FAIL lines. */
function failedIds(run: GateRun): string[] {
  const failLines = run.printed.matchAll(/FAIL\s+(HDC-\d{4}-\d{4})/g);
  return [...failLines].map((match) => match[1]);
}

function sameIds(printed: string[], wanted: string[]): boolean {
  const printedSorted = [...new Set(printed)].sort().join(",");
  return printedSorted === [...wanted].sort().join(",");
}

export default [
  {
    says: "bun run gate v1 exits 0 with no failing case, in under 3 minutes",
    test: async (dir) => {
      const { live } = await gateRuns(dir);
      return live.code === 0 && failedIds(live).length === 0 && live.seconds < 180;
    },
    tryNext:
      "Run bun run gate v1 and read the FAIL lines." +
      " A check that fails the live release is too strict," +
      " for example one that fails every letter with the word fee.",
  },
  {
    says: "bun run gate v3, the friendlier prompt that keeps the fee rule, exits 0",
    test: async (dir) => {
      const { friendly } = await gateRuns(dir);
      return friendly.code === 0 && failedIds(friendly).length === 0;
    },
    tryNext: "Run bun run gate v3. Release v3 asks for every fee, so no case should fail.",
  },
  {
    says: "bun run gate v2 exits 1, so a script that ships releases stops",
    test: async (dir) => (await gateRuns(dir)).bad.code === 1,
    tryNext:
      "Printing FAIL is not enough." +
      " At the end of gate.ts, call process.exit(1) when any case failed.",
  },
  {
    says: `bun run gate v2 prints FAIL for the cases v2 gets wrong (${wrongCaseList}) and no other`,
    test: async (dir) => sameIds(failedIds((await gateRuns(dir)).bad), casesV2GetsWrong()),
    tryNext:
      "Check the missing items as well as the status." +
      " In HDC-2026-0143, release v2 asks for the certificate but forgets the fee.",
  },
  {
    says: "the gate wrote no decision and no letter to the register",
    test: async (dir) => {
      const runs = await gateRuns(dir);
      return runs.live.code !== -1 && runs.registerWrites === 0;
    },
    tryNext:
      "The gate must start the runner with DRY_RUN=1." +
      " A dry run reads the register but never writes to it.",
  },
] satisfies Rule[];

// shadow-the-canary: stable answers every resident, the shadow runs a copy of every request, and
// the shadow never writes to the register.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applicationIds,
  countByRelease,
  runRoots,
  sendRuns,
  serviceNames,
  setDeskBudget,
  startStack,
} from "../parts/05-go-further/go-further-stack";
import type { Rule } from "../scripts/verify";
import { audit, letters, type RegisterRecord, resetWorld, URLS } from "./lib/world";

const SERVICES = ["traefik", "desk-stable", "desk-shadow"];
const RUNS = 20;
type Shadowed = {
  counts: Record<string, number>;
  stable: string;
  sinceReset: RegisterRecord[];
  lettersEach: number[];
};

function stableReleaseId(dir: string): string {
  const releaseFile = readFileSync(join(dir, "release.json"), "utf8");
  return JSON.parse(releaseFile).id;
}

async function registerSinceReset(): Promise<RegisterRecord[]> {
  const entries = await audit();
  const lastReset = entries.filter((entry) => entry.action === "reset").at(-1);
  return entries.filter((entry) => Number(entry.id) > Number(lastReset?.id ?? 0));
}

async function sendShadowedRuns(dir: string): Promise<Shadowed | null> {
  if (!(await startStack(dir, SERVICES)).ok) return null;
  await resetWorld();
  // Every request runs twice, once on stable and once on the shadow.
  await setDeskBudget(5);
  await sendRuns(RUNS, 4);
  await setDeskBudget(2);
  // Both copies of the last runs must have sent their spans before they are counted.
  const roots = await runRoots(RUNS * 2);
  const ids = applicationIds().slice(0, RUNS);
  const lettersEach: number[] = [];
  for (const id of ids) lettersEach.push((await letters(id)).length);
  const sinceReset = await registerSinceReset();
  return { counts: countByRelease(roots), stable: stableReleaseId(dir), sinceReset, lettersEach };
}

// The runs happen once per folder, and every rule below reads the same results.
const resultsByFolder = new Map<string, Promise<Shadowed | null>>();
function shadowed(dir: string): Promise<Shadowed | null> {
  let result = resultsByFolder.get(dir);
  if (!result) {
    result = sendShadowedRuns(dir);
    resultsByFolder.set(dir, result);
  }
  return result;
}

async function stableAnswersEveryTime(dir: string): Promise<boolean> {
  if (!(await startStack(dir, SERVICES)).ok) return false;
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${URLS.desk}/healthz`);
    const health = (await response.json()) as { version?: string };
    if (health.version !== stableReleaseId(dir)) return false;
  }
  return true;
}

function shadowRuns(seen: Shadowed): number {
  const others = Object.entries(seen.counts).filter(([release]) => release !== seen.stable);
  return others.reduce((total, [, count]) => total + count, 0);
}

function shadowLeftNoMark(seen: Shadowed): boolean {
  const decisions = seen.sinceReset.filter((entry) => entry.action === "decision");
  const releases = decisions.map((entry) => (entry.detail as { release?: string }).release);
  const refused = seen.sinceReset.filter((entry) => entry.action === "decision_refused");
  const oneLetterEach = seen.lettersEach.every((count) => count === 1);
  const onlyStable = releases.every((release) => release === seen.stable);
  return decisions.length === RUNS && onlyStable && refused.length === 0 && oneLetterEach;
}

export default [
  {
    says: "compose.yaml has the services traefik, desk-stable and desk-shadow",
    test: async (dir) => {
      const names = await serviceNames(dir);
      return SERVICES.every((name) => names.includes(name));
    },
    tryNext: "Add a desk-shadow service built from this folder, with its own /data volume.",
  },
  {
    says: "every answer on http://localhost:3000 comes from stable, 10 times out of 10",
    test: stableAnswersEveryTime,
    tryNext:
      "The stack starts only when desk-shadow exists, so add it first." +
      " Then: a weighted service lets the shadow answer some residents." +
      " Use a mirroring service: service stable, and a mirror to shadow.",
  },
  {
    says: `stable traced each of ${RUNS} runs`,
    test: async (dir) => {
      const seen = await shadowed(dir);
      return seen?.counts[seen.stable] === RUNS;
    },
    tryNext:
      "Add desk-shadow first: the stack does not start without it." +
      " Then every request must reach stable. Read docker compose logs traefik for errors.",
  },
  {
    says: `the shadow traced a copy of each of the ${RUNS} runs, under another release`,
    test: async (dir) => {
      const seen = await shadowed(dir);
      return seen !== null && shadowRuns(seen) === RUNS;
    },
    tryNext:
      "Mirror 100 percent of requests to the shadow," +
      " and give desk-shadow RELEASE_FILE /app/releases/v3.json.",
  },
  {
    says: "the register holds one decision and one letter per run, all from stable, none refused",
    test: async (dir) => {
      const seen = await shadowed(dir);
      return seen !== null && shadowLeftNoMark(seen);
    },
    tryNext:
      'Set DRY_RUN: "1" on desk-shadow.' +
      " A dry run reads the register but never writes, so it cannot race stable to the decision.",
  },
] satisfies Rule[];

// ship-a-canary: Traefik splits the traffic, 9 in 10 runs to the stable release and the rest to
// the canary release, and every run's trace says which release served it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countByRelease,
  runRoots,
  sendRuns,
  serviceNames,
  setDeskBudget,
  startStack,
} from "../parts/04-release-safely/release-stack";
import type { Rule } from "../scripts/verify";
import { resetWorld, type Span } from "./lib/world";

const SERVICES = ["traefik", "desk-stable", "desk-canary"];
const RUNS = 200;
type Traffic = { roots: Span[]; counts: Record<string, number>; stable: string };

// The stable release is the one in the folder's release.json, the release that is live today.
function stableReleaseId(dir: string): string {
  const releaseFile = readFileSync(join(dir, "release.json"), "utf8");
  return JSON.parse(releaseFile).id;
}

async function driveTraffic(dir: string): Promise<Traffic | null> {
  if (!(await startStack(dir, SERVICES)).ok) return null;
  await resetWorld();
  // 200 replay runs cost about $3, more than the desk key's $2 budget.
  await setDeskBudget(10);
  await sendRuns(RUNS);
  await setDeskBudget(2);
  const roots = await runRoots(RUNS);
  return { roots, counts: countByRelease(roots), stable: stableReleaseId(dir) };
}

// The traffic runs once per folder, and every rule below reads the same spans.
const trafficByFolder = new Map<string, Promise<Traffic | null>>();
function traffic(dir: string): Promise<Traffic | null> {
  let result = trafficByFolder.get(dir);
  if (!result) {
    result = driveTraffic(dir);
    trafficByFolder.set(dir, result);
  }
  return result;
}

function stableShare(seen: Traffic): number {
  return (seen.counts[seen.stable] ?? 0) / seen.roots.length;
}

export default [
  {
    says: "compose.yaml has the services traefik, desk-stable and desk-canary",
    test: async (dir) => {
      const names = await serviceNames(dir);
      return SERVICES.every((name) => names.includes(name));
    },
    tryNext:
      "Split the desk service into desk-stable and desk-canary, built from this folder," +
      " and add a traefik service that owns port 3000.",
  },
  {
    says: "the stack starts and http://localhost:3000/healthz answers through Traefik",
    test: async (dir) => (await startStack(dir, SERVICES)).ok,
    tryNext:
      "Run bun run up ship-a-canary and read the error." +
      " Only traefik publishes port 3000; the desks publish no port.",
  },
  {
    says: `each of ${RUNS} runs has a trace whose root span names its release.id`,
    test: async (dir) => {
      const seen = await traffic(dir);
      if (!seen || seen.roots.length < RUNS) return false;
      return seen.roots.every((root) => typeof root.attributes["release.id"] === "string");
    },
    tryNext:
      "Every run must reach a desk. Check docker compose -p hdc-desk logs traefik" +
      " for a router or service it could not use.",
  },
  {
    says: "the stable release serves between 80% and 99% of the runs",
    test: async (dir) => {
      const seen = await traffic(dir);
      if (!seen?.roots.length) return false;
      const share = stableShare(seen);
      return share >= 0.8 && share <= 0.99;
    },
    tryNext:
      "In traefik/dynamic.yml, give the weighted service two entries:" +
      " stable with weight 90 and canary with weight 10.",
  },
  {
    says: "the canary serves the rest, with another release id in its spans",
    test: async (dir) => {
      const seen = await traffic(dir);
      if (!seen) return false;
      const others = Object.keys(seen.counts).filter((release) => release !== seen.stable);
      return others.length === 1 && others[0] !== "none";
    },
    tryNext:
      "Give desk-canary its own release file:" +
      " set RELEASE_FILE to /app/releases/v3.json in its environment.",
  },
] satisfies Rule[];

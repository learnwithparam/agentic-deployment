// biome-ignore-all lint/style/useNamingConvention: deploy.toml names the field public_url
// deploy-to-the-cloud: the desk answers the stream contract at the address in deploy.toml, keeps
// its staff route closed, and no file in the folder holds a key.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { composeEnv } from "../world/cli/lib";
import { PROJECT, startDesk } from "./lib/desk";
import { dataField, postRun, type RunResult } from "./lib/sse";
import { application, letters, resetWorld, world } from "./lib/world";

const APPS = ["HDC-2026-0142", "HDC-2026-0145", "HDC-2026-0150"];
// A gateway key or the admin key, the way the world makes them.
const KEY_PATTERN = /hdc-(gw|admin)-[0-9a-f]{20,}/;
type DeployFile = { public_url?: string };

/** The address in deploy.toml, without a trailing slash, or an empty string. */
function publicUrl(dir: string): string {
  const file = join(dir, "deploy.toml");
  if (!existsSync(file)) return "";
  const deploy = Bun.TOML.parse(readFileSync(file, "utf8")) as DeployFile;
  const url = String(deploy.public_url ?? "");
  return /^https?:\/\/\S+$/.test(url) ? url.replace(/\/$/, "") : "";
}

// An address on this machine is the local stand-in for a host, so the check starts it first.
function isOnThisMachine(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

// A desk the check starts on this machine is stopped and removed when the check run ends.
let cleanUpOnExit = false;
function removeDeskOnExit() {
  if (cleanUpOnExit) return;
  cleanUpOnExit = true;
  process.on("exit", () => {
    const takeDown = ["docker", "compose", "-p", PROJECT, "down", "-v", "--timeout", "2"];
    Bun.spawnSync(takeDown, { env: { ...process.env, ...composeEnv() } });
  });
}

async function ready(dir: string): Promise<string> {
  const url = publicUrl(dir);
  if (!url) return "";
  await world();
  if (!isOnThisMachine(url)) return url;
  removeDeskOnExit();
  return (await startDesk(dir)).ok ? url : "";
}

async function runEachApplication(dir: string): Promise<RunResult[]> {
  const url = await ready(dir);
  if (!url) return [];
  await resetWorld();
  const results: RunResult[] = [];
  for (const id of APPS) {
    const resident = { "x-resident-id": `deploy-check-${id}` };
    results.push(await postRun(id, url, resident));
  }
  return results;
}

// The three runs happen once per folder, and every rule below reads the same results.
const runsByFolder = new Map<string, Promise<RunResult[]>>();
function threeRuns(dir: string): Promise<RunResult[]> {
  let runs = runsByFolder.get(dir);
  if (!runs) {
    runs = runEachApplication(dir).catch(() => []);
    runsByFolder.set(dir, runs);
  }
  return runs;
}

function streamsTokensThenDone(run: RunResult): boolean {
  const names = run.events.map((event) => event.event);
  const tokensFirst = names.includes("token") && names.indexOf("token") < names.indexOf("done");
  const done = run.events.at(-1);
  const endsDone = done?.event === "done" && dataField(done, "status") === "done";
  // A host far away adds time on the network, so the first event may take up to 5 seconds.
  const quick = run.firstMs !== null && run.firstMs < 5000;
  return run.contentType.includes("text/event-stream") && tokensFirst && endsDone && quick;
}

async function eachRunLeftOneLetter(dir: string): Promise<boolean> {
  if ((await threeRuns(dir)).length !== APPS.length) return false;
  for (const id of APPS) {
    if ((await application(id)).status === "received") return false;
    if ((await letters(id)).length !== 1) return false;
  }
  return true;
}

function filesIn(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder)) {
    if (entry === "node_modules") continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) filesIn(path, found);
    else found.push(path);
  }
  return found;
}

export default [
  {
    says: "deploy.toml names public_url, the address where the host serves the desk",
    test: (dir) => publicUrl(dir) !== "",
    tryNext: 'Deploy the image, then write public_url = "https://..." in deploy.toml.',
  },
  {
    says: "GET <public_url>/healthz answers 200 with status ok and the release version",
    test: async (dir) => {
      const url = await ready(dir);
      if (!url) return false;
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10_000) });
      const health = (await response.json()) as { status?: string; version?: string };
      return response.status === 200 && health.status === "ok" && Boolean(health.version);
    },
    tryNext:
      "Open the address in a browser. If the host shows its own error page," +
      " check the port: the desk listens on 3000, or on PORT when the host sets it.",
  },
  {
    says: "3 runs stream token events, then a done event, the first event within 5 seconds",
    test: async (dir) => {
      const results = await threeRuns(dir);
      return results.length === APPS.length && results.every(streamsTokensThenDone);
    },
    tryNext:
      "The desk on the host must reach the world." +
      " Set REGISTER_URL and GATEWAY_URL to addresses the host can reach.",
  },
  {
    says: "each run left its decision and exactly one letter in the register",
    test: eachRunLeftOneLetter,
    tryNext: "Open http://localhost:7001 and read the host's logs for errors from the register.",
  },
  {
    says: "POST <public_url>/v1/applications/<id>/validate with no token answers 401",
    test: async (dir) => {
      const url = await ready(dir);
      if (!url) return false;
      const target = `${url}/v1/applications/HDC-2026-0151/validate`;
      const response = await fetch(target, { method: "POST", redirect: "manual" });
      return response.status === 401;
    },
    tryNext:
      "Ship the image from this folder, which checks the token." +
      " An older image may have no sign-in at all.",
  },
  {
    says: "no file in this folder holds a gateway key or the admin key",
    test: (dir) => {
      const files = filesIn(dir);
      return files.every((file) => !KEY_PATTERN.test(readFileSync(file, "utf8")));
    },
    tryNext:
      "Keys go in the host's secret store, never in a file you commit." +
      " Mount the secret as a file and point GATEWAY_KEY_FILE at it.",
  },
] satisfies Rule[];

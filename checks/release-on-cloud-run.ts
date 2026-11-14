// release-on-cloud-run: the learner's release.ts deploys the desk to Cloud Run in floci-gcp,
// ships a second revision and rolls back. The check starts the folder's own Compose file and runs
// the folder's release.ts. Then it judges what the emulator holds. It never imports their code.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { ROOT, runCommand } from "../world/cli/lib";

const EMULATOR = "http://localhost:4588";
const PARENT = "projects/floci-local/locations/us-central1";
const SECRET = "projects/floci-local/secrets/desk-gateway-key";
const PROJECT = "floci-cloud-run";
const IMAGE = "hdc-desk:cloud-run";
const IMAGE_FOLDER = join(ROOT, "parts", "05-go-further", "02-deploy-to-the-cloud", "solution");
const PINNED_EMULATOR = "floci/floci-gcp:0.12.0";
// A gateway key the way the world makes it. Only a fake key belongs in this step.
const REAL_KEY_PATTERN = /hdc-(gw|admin)-[0-9a-f]{20,}/;

type Snapshot = {
  ran: boolean;
  keyInSecretManager: string;
  latestReadyRevision: string;
  health: string;
};
export type Session = {
  deploy: Snapshot;
  callOutput: string;
  ship: Snapshot;
  rollback: Snapshot;
  revisionCount: number;
};

const empty: Snapshot = { ran: false, keyInSecretManager: "", latestReadyRevision: "", health: "" };

async function readJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${EMULATOR}${path}`, { signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return text.startsWith("{") ? JSON.parse(text) : { text };
}

async function snapshot(ran: boolean): Promise<Snapshot> {
  if (!ran) return empty;
  const version = (await readJson(`/v1/${SECRET}/versions/latest:access`)) as {
    payload?: { data?: string };
  };
  const service = await readJson(`/v2/${PARENT}/services/desk`);
  const health = await readJson(`/run/v2/${PARENT}/services/desk/healthz`);
  const encodedKey = version.payload?.data ?? "";
  return {
    ran,
    keyInSecretManager: Buffer.from(encodedKey, "base64").toString("utf8"),
    latestReadyRevision:
      String(service.latestReadyRevision ?? "")
        .split("/")
        .pop() ?? "",
    health: String(health.version ?? ""),
  };
}

const compose = (dir: string, ...args: string[]) =>
  runCommand(["docker", "compose", "-p", PROJECT, "-f", join(dir, "docker-compose.yml"), ...args], {
    cwd: dir,
  });

// The emulator keeps its state in memory, so a fresh start gives each folder a clean cloud.
async function startEmulator(dir: string): Promise<boolean> {
  await stopEmulator();
  const started = await compose(dir, "up", "-d");
  if (started.code !== 0) return false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetch(`${EMULATOR}/`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await Bun.sleep(500);
    }
  }
  return false;
}

async function stopEmulator(): Promise<void> {
  const down = ["docker", "compose", "-p", PROJECT, "down", "-v", "--remove-orphans"];
  await runCommand([...down, "--timeout", "2"]);
  const leftovers = await runCommand([
    "docker",
    "ps",
    "-aq",
    "--filter",
    "name=floci-gcp-cloudrun",
  ]);
  const ids = leftovers.out.split("\n").filter(Boolean);
  if (ids.length > 0) await runCommand(["docker", "rm", "-f", ...ids]);
}

let cleanUpOnExit = false;
function removeEmulatorOnExit() {
  if (cleanUpOnExit) return;
  cleanUpOnExit = true;
  process.on("exit", () => {
    Bun.spawnSync(["docker", "compose", "-p", PROJECT, "down", "-v", "--timeout", "2"]);
    const listing = Bun.spawnSync(["docker", "ps", "-aq", "--filter", "name=floci-gcp-cloudrun"]);
    const ids = listing.stdout.toString().split("\n").filter(Boolean);
    if (ids.length > 0) Bun.spawnSync(["docker", "rm", "-f", ...ids]);
  });
}

async function ensureImage(): Promise<boolean> {
  const found = await runCommand(["docker", "image", "inspect", IMAGE]);
  if (found.code === 0) return true;
  const build = await runCommand(["docker", "build", "-t", IMAGE, IMAGE_FOLDER]);
  return build.code === 0;
}

async function release(dir: string, command: string): Promise<{ ok: boolean; out: string }> {
  const finished = await runCommand(["bun", "release.ts", command], { cwd: dir });
  return { ok: finished.code === 0, out: finished.out };
}

async function revisionCount(): Promise<number> {
  const listing = (await readJson(`/v2/${PARENT}/services/desk/revisions`)) as {
    revisions?: unknown[];
  };
  return listing.revisions?.length ?? 0;
}

async function runSession(dir: string): Promise<Session> {
  const nothing: Session = {
    deploy: empty,
    callOutput: "",
    ship: empty,
    rollback: empty,
    revisionCount: 0,
  };
  removeEmulatorOnExit();
  const ready = existsSync(join(dir, "release.ts")) && (await ensureImage());
  if (!ready || !(await startEmulator(dir))) return nothing;
  const session = { ...nothing };
  const deployed = await release(dir, "deploy");
  session.deploy = await snapshot(deployed.ok);
  if (!deployed.ok) return session;
  session.callOutput = (await release(dir, "call")).out;
  const shipped = await release(dir, "ship");
  session.ship = await snapshot(shipped.ok);
  if (!shipped.ok) return session;
  const rolledBack = await release(dir, "rollback");
  session.rollback = await snapshot(rolledBack.ok);
  session.revisionCount = await revisionCount();
  return session;
}

const sessions = new Map<string, Promise<Session>>();
/** One run of deploy, call, ship and rollback per folder. Every rule reads the same run. */
export function sessionFor(dir: string): Promise<Session> {
  let session = sessions.get(dir);
  if (!session) {
    session = runSession(dir).catch(failedSession);
    sessions.set(dir, session);
  }
  return session;
}

const failedSession = (): Session => ({
  deploy: empty,
  callOutput: "",
  ship: empty,
  rollback: empty,
  revisionCount: 0,
});

type ComposeFile = {
  services?: Record<string, { image?: string; ports?: { published?: string; target?: number }[] }>;
};

/** True when the Compose file runs floci-gcp 0.12.0 on port 4588 with the Docker socket. */
export async function composeRunsPinnedEmulator(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, "docker-compose.yml"))) return false;
  const config = await compose(dir, "config", "--format", "json");
  if (config.code !== 0) return false;
  const services = Object.values((JSON.parse(config.out) as ComposeFile).services ?? {});
  const emulator = services.find((service) => service.image === PINNED_EMULATOR);
  const publishesPort = emulator?.ports?.some((port) => String(port.published) === "4588");
  const text = readFileSync(join(dir, "docker-compose.yml"), "utf8");
  return Boolean(publishesPort) && text.includes("/var/run/docker.sock");
}

function textFilesIn(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder)) {
    if (entry === "node_modules") continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) textFilesIn(path, found);
    else found.push(path);
  }
  return found;
}

const fakeKey = (dir: string) => readFileSync(join(dir, "fake-key.txt"), "utf8").trim();

/** True when the key sits only in fake-key.txt, and no real-looking key is in any file. */
export function keyStaysOutOfCode(dir: string): boolean {
  if (!existsSync(join(dir, "fake-key.txt"))) return false;
  const key = fakeKey(dir);
  const files = textFilesIn(dir);
  const noRealKey = files.every((file) => !REAL_KEY_PATTERN.test(readFileSync(file, "utf8")));
  const codeFiles = files.filter((file) => /\.(ts|js|json|ya?ml)$/.test(file));
  const noKeyInCode = codeFiles.every((file) => !readFileSync(file, "utf8").includes(key));
  return key.length > 0 && noRealKey && noKeyInCode;
}

export default [
  {
    says: "docker-compose.yml runs floci/floci-gcp:0.12.0 on port 4588, with the Docker socket",
    test: composeRunsPinnedEmulator,
    tryNext:
      "Add a floci-gcp service with image floci/floci-gcp:0.12.0, ports 4588:4588 and the volume" +
      " /var/run/docker.sock:/var/run/docker.sock.",
  },
  {
    says: "deploy stores the fake key from fake-key.txt in Secret Manager",
    test: async (dir) => {
      const session = await sessionFor(dir);
      const key = session.deploy.keyInSecretManager;
      return key !== "" && key === fakeKey(dir);
    },
    tryNext:
      "Create the secret desk-gateway-key with POST /v1/projects/floci-local/secrets, then add a" +
      " version with the key as base64 under payload.data.",
  },
  {
    says: "deploy creates the Cloud Run service desk, and revision desk-00001 serves release v1",
    test: async (dir) => {
      const { deploy } = await sessionFor(dir);
      return deploy.latestReadyRevision === "desk-00001" && deploy.health === "v1";
    },
    tryNext:
      "POST /v2/projects/floci-local/locations/us-central1/services?serviceId=desk, then wait" +
      " until latestReadyRevision is desk-00001. The desk listens on port 3000.",
  },
  {
    says: "call prints the desk's health answer, which names release v1",
    test: async (dir) => {
      const { callOutput } = await sessionFor(dir);
      return callOutput.includes('"status":"ok"') && callOutput.includes('"version":"v1"');
    },
    tryNext:
      "GET /run/v2/projects/floci-local/locations/us-central1/services/desk/healthz and print" +
      " the answer.",
  },
  {
    says: "ship adds revision desk-00002, which serves release v2",
    test: async (dir) => {
      const { ship } = await sessionFor(dir);
      return ship.latestReadyRevision === "desk-00002" && ship.health === "v2";
    },
    tryNext:
      "PATCH the same service path with RELEASE_FILE set to releases/v2.json. A changed template" +
      " makes revision desk-00002.",
  },
  {
    says: "rollback serves release v1 again, through a new revision desk-00003",
    test: async (dir) => {
      const { rollback, revisionCount } = await sessionFor(dir);
      const serving = rollback.latestReadyRevision === "desk-00003" && rollback.health === "v1";
      return serving && revisionCount === 3;
    },
    tryNext:
      "Do not move traffic: the emulator stores a traffic setting but does not apply it." +
      " PATCH the service with the first template again. That makes desk-00003, and it serves v1.",
  },
  {
    says: "the fake key lives only in fake-key.txt, and no file holds a real key",
    test: keyStaysOutOfCode,
    tryNext:
      "Read the key from fake-key.txt when you store it, and from Secret Manager when you deploy." +
      " Never write it in release.ts.",
  },
] satisfies Rule[];

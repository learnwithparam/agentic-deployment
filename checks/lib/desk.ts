// biome-ignore-all lint/style/useNamingConvention: docker inspect fields are PascalCase, like State
// Start the learner's desk from a folder with Docker Compose, and look at what is running.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { composeEnv, healthy, runCommand, URLS } from "../../world/cli/lib";
import { world } from "./world";

export const PROJECT = "hdc-desk";
let current: { dir: string; result: Promise<Started> } | null = null;
export type Started = { ok: boolean; why: string };

/** One service in `docker compose config --format json`. Checks read only these fields. */
export type ComposeService = {
  build?: unknown;
  secrets?: { source: string }[];
  [field: string]: unknown;
};
/** The whole project as `docker compose config --format json` prints it. */
export type ComposeConfig = {
  services?: Record<string, ComposeService>;
  secrets?: Record<string, { file?: string }>;
  [field: string]: unknown;
};
/** The parts of `docker inspect` the checks read. Docker names these fields in PascalCase. */
export type ContainerDetails = {
  Image?: string;
  Config?: { Env?: string[] };
  State?: { Health?: { Status?: string } };
  [field: string]: unknown;
};

const compose = (dir: string, ...args: string[]) =>
  runCommand(["docker", "compose", "-p", PROJECT, "-f", join(dir, "compose.yaml"), ...args], {
    env: composeEnv(),
    cwd: dir,
  });

// The last few lines of a failed command are where Docker says what went wrong.
function lastLines(printed: string): string {
  const lines = printed.trim().split("\n");
  return lines.slice(-4).join(" / ");
}

async function buildAndStart(dir: string): Promise<Started> {
  try {
    await world();
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }
  const takeDown = [
    "docker",
    "compose",
    "-p",
    PROJECT,
    "down",
    "--remove-orphans",
    "--timeout",
    "2",
  ];
  await runCommand(takeDown, { env: composeEnv() });
  if (!existsSync(join(dir, "compose.yaml"))) {
    return { ok: false, why: "there is no compose.yaml" };
  }
  if (!(await deskService(dir))) {
    return { ok: false, why: 'compose.yaml has no service named "desk"' };
  }
  const started = await compose(dir, "up", "-d", "--build", "--wait", "--wait-timeout", "60");
  if (started.code !== 0) {
    return { ok: false, why: lastLines(started.err || started.out) };
  }
  if (!(await healthy(`${URLS.desk}/healthz`, 10))) {
    return { ok: false, why: "nothing answers on http://localhost:3000/healthz" };
  }
  return { ok: true, why: "" };
}

/** Build and start the desk in this folder, once per check run. Later calls get the same answer. */
export function startDesk(dir: string): Promise<Started> {
  if (current?.dir === dir) return current.result;
  const result = buildAndStart(dir);
  current = { dir, result };
  return result;
}

/** The desk service as Compose sees it after variables are filled in, or null. */
export async function deskService(dir: string): Promise<ComposeService | null> {
  if (!existsSync(join(dir, "compose.yaml"))) return null;
  const config = await composeConfig(dir);
  return config?.services?.desk ?? null;
}

export async function composeConfig(dir: string): Promise<ComposeConfig | null> {
  const printed = await compose(dir, "config", "--format", "json");
  if (printed.code !== 0) return null;
  try {
    return JSON.parse(printed.out) as ComposeConfig;
  } catch {
    return null;
  }
}

async function deskContainerId(): Promise<string> {
  const listing = ["docker", "compose", "-p", PROJECT, "ps", "-q", "desk"];
  const printed = await runCommand(listing, { env: composeEnv() });
  return printed.out.trim();
}

/** docker inspect of the running desk container. */
export async function container(): Promise<ContainerDetails | null> {
  const id = await deskContainerId();
  if (!id) return null;
  const inspected = await runCommand(["docker", "inspect", id]);
  if (inspected.code !== 0) return null;
  const details = JSON.parse(inspected.out) as ContainerDetails[];
  return details[0];
}

export async function exec(...command: string[]) {
  const id = await deskContainerId();
  return runCommand(["docker", "exec", id, ...command]);
}

/** The image the running desk was built from. */
export async function image(): Promise<string | null> {
  return (await container())?.Image ?? null;
}

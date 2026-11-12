// Start the learner's desk from a folder with Docker Compose, and look at what is running.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { composeEnv, healthy, sh, URLS } from "../../world/cli/lib";
import { world } from "./world";

export const PROJECT = "hdc-desk";
let current: { dir: string; result: Promise<Started> } | null = null;
export type Started = { ok: boolean; why: string };

const compose = (dir: string, ...args: string[]) =>
  sh(["docker", "compose", "-p", PROJECT, "-f", join(dir, "compose.yaml"), ...args], {
    env: composeEnv(),
    cwd: dir,
  });

/** Build and start the desk in this folder, once per check run. Later calls get the same answer. */
export function startDesk(dir: string): Promise<Started> {
  if (current?.dir === dir) return current.result;
  const result = (async (): Promise<Started> => {
    try {
      await world();
    } catch (e) {
      return { ok: false, why: (e as Error).message };
    }
    await sh(["docker", "compose", "-p", PROJECT, "down", "--remove-orphans", "--timeout", "2"], {
      env: composeEnv(),
    });
    if (!existsSync(join(dir, "compose.yaml")))
      return { ok: false, why: "there is no compose.yaml" };
    if (!(await deskService(dir)))
      return { ok: false, why: 'compose.yaml has no service named "desk"' };
    const up = await compose(dir, "up", "-d", "--build", "--wait", "--wait-timeout", "60");
    if (up.code !== 0)
      return { ok: false, why: (up.err || up.out).trim().split("\n").slice(-4).join(" / ") };
    if (!(await healthy(`${URLS.desk}/healthz`, 10)))
      return { ok: false, why: "nothing answers on http://localhost:3000/healthz" };
    return { ok: true, why: "" };
  })();
  current = { dir, result };
  return result;
}

/** The desk service as Compose sees it after variables are filled in, or null. */
export async function deskService(dir: string): Promise<any | null> {
  if (!existsSync(join(dir, "compose.yaml"))) return null;
  const r = await compose(dir, "config", "--format", "json");
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out).services?.desk ?? null;
  } catch {
    return null;
  }
}

export async function composeConfig(dir: string): Promise<any | null> {
  const r = await compose(dir, "config", "--format", "json");
  try {
    return r.code === 0 ? JSON.parse(r.out) : null;
  } catch {
    return null;
  }
}

/** docker inspect of the running desk container. */
export async function container(): Promise<any | null> {
  const id = (
    await sh(["docker", "compose", "-p", PROJECT, "ps", "-q", "desk"], { env: composeEnv() })
  ).out.trim();
  if (!id) return null;
  const r = await sh(["docker", "inspect", id]);
  return r.code === 0 ? JSON.parse(r.out)[0] : null;
}

export async function exec(...cmd: string[]) {
  const id = (
    await sh(["docker", "compose", "-p", PROJECT, "ps", "-q", "desk"], { env: composeEnv() })
  ).out.trim();
  return sh(["docker", "exec", id, ...cmd]);
}

/** The image the running desk was built from. */
export async function image(): Promise<string | null> {
  return (await container())?.Image ?? null;
}

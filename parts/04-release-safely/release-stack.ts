// biome-ignore-all lint/style/useNamingConvention: JSON fields stay as the world sends them
// Helpers for the checks of the release steps, where the desk is more than one container:
// Traefik in front, a stable desk and a canary desk, and later Prometheus, Alertmanager and the
// release controller. Only Bun built-ins, like checks/lib.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { postRun } from "../../checks/lib/sse";
import { resetWorld, type Span, spans, world } from "../../checks/lib/world";
import { admin, composeEnv, healthy, runCommand, URLS } from "../../world/cli/lib";

export const PROJECT = "hdc-desk";
type Started = { ok: boolean; why: string };
type ComposeServices = { services?: Record<string, unknown> };

const compose = (dir: string, ...args: string[]) =>
  runCommand(["docker", "compose", "-p", PROJECT, "-f", join(dir, "compose.yaml"), ...args], {
    env: composeEnv(),
    cwd: dir,
  });

/** The service names in this folder's compose.yaml, or an empty list. */
export async function serviceNames(dir: string): Promise<string[]> {
  if (!existsSync(join(dir, "compose.yaml"))) return [];
  const printed = await compose(dir, "config", "--format", "json");
  if (printed.code !== 0) return [];
  const config = JSON.parse(printed.out) as ComposeServices;
  return Object.keys(config.services ?? {});
}

// The finished desk uses the same container names on the same network, so it must be down.
async function stopEverythingElse() {
  const options = { env: composeEnv() };
  await runCommand(["docker", "compose", "-f", "world/finished/compose.yaml", "down"], options);
  await runCommand(["docker", "compose", "-p", PROJECT, "down", "-v", "--timeout", "2"], options);
}

// Containers a check starts are stopped and removed when the check run ends.
let cleanUpOnExit = false;
function removeStackOnExit() {
  if (cleanUpOnExit) return;
  cleanUpOnExit = true;
  process.on("exit", () => {
    const takeDown = ["docker", "compose", "-p", PROJECT, "down", "-v", "--timeout", "2"];
    Bun.spawnSync(takeDown, { env: { ...process.env, ...composeEnv() } });
  });
}

async function buildAndStart(dir: string, needed: string[]): Promise<Started> {
  await world();
  const names = await serviceNames(dir);
  const missing = needed.filter((name) => !names.includes(name));
  if (missing.length) return { ok: false, why: `compose.yaml has no ${missing.join(", ")}` };
  await stopEverythingElse();
  removeStackOnExit();
  const started = await compose(dir, "up", "-d", "--build", "--wait", "--wait-timeout", "90");
  if (started.code !== 0) {
    const lines = (started.err || started.out).trim().split("\n");
    return { ok: false, why: lines.slice(-4).join(" / ") };
  }
  if (!(await healthy(`${URLS.desk}/healthz`, 15))) {
    return { ok: false, why: "nothing answers on http://localhost:3000/healthz" };
  }
  return { ok: true, why: "" };
}

let current: { dir: string; result: Promise<Started> } | null = null;
/** Build and start the stack in this folder once per check run. Later calls share the answer. */
export function startStack(dir: string, needed: string[]): Promise<Started> {
  if (current?.dir === dir) return current.result;
  const result = buildAndStart(dir, needed);
  current = { dir, result };
  return result;
}

/** Every application except the runaway one, which would slow every lap. */
export function applicationIds(): string[] {
  const all = Array.from({ length: 40 }, (_, i) => `HDC-2026-0${140 + i}`);
  return all.filter((id) => id !== "HDC-2026-0177");
}

/** Reopen an application, so a new run may write its decision again. */
export function reopen(ids: string[]) {
  return fetch(`${URLS.register}/admin/reopen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

/** Send runs through Traefik on :3000, a few at a time, each from a new resident. */
export async function sendRuns(count: number, batchSize = 8): Promise<void> {
  const ids = applicationIds();
  for (let first = 0; first < count; first += batchSize) {
    const batch: Promise<unknown>[] = [];
    for (let i = first; i < Math.min(first + batchSize, count); i++) {
      const id = ids[i % ids.length];
      const resident = { "x-resident-id": `check-${Date.now()}-${i}` };
      const run = reopen([id]).then(() => postRun(id, URLS.desk, resident));
      batch.push(run.catch(() => null));
    }
    await Promise.all(batch);
  }
}

/** Runs cost money even in replay, so a long check raises the desk key's budget for a while. */
export function setDeskBudget(dollars: number) {
  return admin("/admin/budget", { name: "desk", max_budget_usd: dollars });
}

const isRunRoot = (span: Span) => !span.parent_span_id && "run.id" in span.attributes;

/** The root span of every run the trace desk holds. Waits for late batches to arrive. */
export async function runRoots(atLeast: number): Promise<Span[]> {
  let roots: Span[] = [];
  for (let i = 0; i < 20; i++) {
    roots = (await spans()).filter(isRunRoot);
    if (roots.length >= atLeast) break;
    await Bun.sleep(500);
  }
  return roots;
}

/** How many root spans carry each release id. */
export function countByRelease(roots: Span[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of roots) {
    const release = String(root.attributes["release.id"] ?? "none");
    counts[release] = (counts[release] ?? 0) + 1;
  }
  return counts;
}

// The canary drill: put a release on the canary, send residents' runs, and watch what the
// release controller does with no one at the keyboard.
export const CONTROLLER = "http://localhost:7010";

type AuditEntry = { action: string; release?: string; alert?: string; weight?: number };
export type ControllerState = {
  canary_release: string;
  canary_weight: number;
  audit: AuditEntry[];
};
type PrometheusAlert = { state: string; labels: Record<string, string> };

export async function controllerState(): Promise<ControllerState> {
  const response = await fetch(`${CONTROLLER}/state`);
  return (await response.json()) as ControllerState;
}

/** The alerts Prometheus holds right now, firing or pending. */
export async function prometheusAlerts(): Promise<PrometheusAlert[]> {
  const response = await fetch(`${URLS.prometheus}/api/v1/alerts`);
  const answer = (await response.json()) as { data: { alerts: PrometheusAlert[] } };
  return answer.data.alerts;
}

// Prometheus may still be starting, for example just after `docker compose restart prometheus`.
// Until it answers, there is no list of alerts yet, so the caller waits and asks again.
async function alertsOnceReady(): Promise<PrometheusAlert[] | null> {
  try {
    return await prometheusAlerts();
  } catch {
    return null;
  }
}

// After a reset, wait until Prometheus has seen the empty register, so an old alert cannot roll
// back the new canary.
async function waitForNoAlerts() {
  for (let i = 0; i < 30; i++) {
    const alerts = await alertsOnceReady();
    if (alerts !== null && alerts.length === 0) return;
    await Bun.sleep(1000);
  }
}

async function startCanary(release: string) {
  await resetWorld();
  await fetch(`${CONTROLLER}/reset`, { method: "POST" });
  await waitForNoAlerts();
  await fetch(`${CONTROLLER}/canary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ release, weight: 10 }),
  });
  // Traefik reads the controller's new file within a second or two.
  await Bun.sleep(3000);
}

export type Drill = {
  release: string;
  runs: number;
  seconds: number;
  rollback: AuditEntry | undefined;
  weightAtEnd: number;
};

const findRollback = (state: ControllerState) =>
  state.audit.find((entry) => entry.action === "rollback");

/** True when Prometheus fires an alert about this release. */
export async function alertFiresFor(release: string): Promise<boolean> {
  const alerts = await prometheusAlerts();
  return alerts.some((alert) => alert.state === "firing" && alert.labels.release === release);
}

// Alertmanager repeats a firing alert every few seconds. After 30 seconds of firing with no
// rollback, the alert is not reaching the controller, so waiting longer will not help.
const FIRING_WITHOUT_ROLLBACK_SECONDS = 30;

/** Send a few runs every half second until the controller rolls the canary back, or time is up. */
export async function canaryDrill(release: string, seconds: number, log = (_line: string) => {}) {
  await startCanary(release);
  log(`Release ${release} is live as a canary on 10% of traffic. Nobody touches the keyboard now.`);
  const startedAt = Date.now();
  const secondsGone = () => (Date.now() - startedAt) / 1000;
  let runs = 0;
  let firstFiring: number | null = null;
  let state = await controllerState();
  while (!findRollback(state) && secondsGone() < seconds) {
    await sendRuns(4, 4);
    runs += 4;
    await Bun.sleep(500);
    state = await controllerState();
    if (firstFiring === null && (await anyAlertFiring())) firstFiring = secondsGone();
    if (firstFiring !== null && secondsGone() - firstFiring > FIRING_WITHOUT_ROLLBACK_SECONDS) {
      log("An alert has fired for 30 s, and the controller has not rolled back.");
      break;
    }
    if (runs % 80 === 0) log(`  ${runs} runs sent, canary still at ${state.canary_weight}%...`);
  }
  const drill: Drill = {
    release,
    runs,
    seconds: secondsGone(),
    rollback: findRollback(state),
    weightAtEnd: state.canary_weight,
  };
  return drill;
}

async function anyAlertFiring(): Promise<boolean> {
  const alerts = await prometheusAlerts();
  return alerts.some((alert) => alert.state === "firing");
}

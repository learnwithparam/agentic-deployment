// biome-ignore-all lint/style/useNamingConvention: register and gateway JSON use names like run_id
// Plant a fault and watch what the desk does. Each one uses the replay model, so it costs nothing.
//   bun run chaos runaway [--desk]   send the runaway application HDC-2026-0177
//   bun run chaos kill [--desk]      stop the desk between the register write and the letter,
//                                    then restart it
//   bun run chaos bad-canary         ship release v2 as a 10% canary to the finished desk and
//                                    drive traffic
import { admin, composeEnv, gatewayProvider, healthy, resetWorld, runCommand, URLS } from "./lib";

const fault = process.argv[2];
const toDesk = process.argv.includes("--desk");
const base = toDesk ? URLS.desk : URLS.finished;
const CONTROLLER = "http://localhost:7010";

type DoneEvent = { run_id?: string; status?: string };
type ErrorEvent = { message?: string };
type RunResult = { status: number; done?: DoneEvent; error?: ErrorEvent };
type SpendLine = { run_id: string | null; cost_usd: number | null };
type AuditEntry = {
  id: number;
  action: string;
  application_id: string | null;
  detail: AuditDetail;
};
type AuditDetail = { ids?: string[] };
type Rollback = { action: string; alert: string; release: string };

async function deskContainer(): Promise<string> {
  const options = { env: composeEnv() };
  if (toDesk) {
    const command = ["docker", "compose", "-p", "hdc-desk", "ps", "-q", "desk"];
    return (await runCommand(command, options)).out.trim();
  }
  const finished = ["docker", "compose", "-f", "world/finished/compose.yaml"];
  return (await runCommand([...finished, "ps", "-q", "desk-stable"], options)).out.trim();
}

/** Call the register: GET when there is no body, POST when there is. */
async function register<Answer = unknown>(path: string, body?: unknown): Promise<Answer> {
  const request =
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(`${URLS.register}${path}`, request);
  return (await response.json()) as Answer;
}

function lastEvent<Event>(streamText: string, eventName: string): Event | undefined {
  const pattern = new RegExp(`event: ${eventName}\\ndata: (.*)`, "g");
  const events = [...streamText.matchAll(pattern)].map((match) => JSON.parse(match[1]));
  return events.at(-1);
}

async function runApplication(id: string): Promise<RunResult> {
  const resident = `chaos-${Date.now()}-${Math.random()}`;
  const response = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-resident-id": resident },
    body: JSON.stringify({ application_id: id }),
  });
  const streamText = await response.text();
  return {
    status: response.status,
    done: lastEvent<DoneEvent>(streamText, "done"),
    error: lastEvent<ErrorEvent>(streamText, "error"),
  };
}

const secondsSince = (start: number) => (Date.now() - start) / 1000;

async function runaway() {
  await register("/admin/reopen", { ids: ["HDC-2026-0177"] });
  console.log(
    "Sending HDC-2026-0177, whose attachment list never ends. " +
      "A desk with no brakes keeps going until the gateway budget runs out.",
  );
  const start = Date.now();
  const tooLong = Bun.sleep(60_000).then(() => null);
  const result = await Promise.race([runApplication("HDC-2026-0177"), tooLong]);
  if (!result) {
    console.log("The run did not stop within 60 seconds. It has no step limit or dollar limit.");
    process.exit(1);
  }
  const spendLog = await admin<SpendLine[]>("/admin/spend");
  const spent = spendLog.filter((line) => line.run_id === result.done?.run_id);
  const cost = spent.reduce((total, line) => total + (line.cost_usd ?? 0), 0);
  const howItEnded = result.done?.status ?? "no done event";
  const took = `${secondsSince(start).toFixed(1)} s`;
  console.log(
    `The run ended: ${howItEnded} after ${spent.length} model calls, $${cost.toFixed(4)}, ${took}.`,
  );
  if (result.error) console.log(`The resident saw: ${result.error.message}`);
}

async function waitForDecision(id: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(250);
    const application = await register<{ status: string }>(`/applications/${id}`);
    if (application.status !== "received") return true;
  }
  return false;
}

async function countDecisionsAndLetters(id: string) {
  const letters = await register<unknown[]>(`/letters?application_id=${id}`);
  const log = await register<AuditEntry[]>("/audit");
  // Count only decisions made after this run reopened the application.
  const reopens = log.filter(
    (entry) => entry.action === "reopen" && entry.detail.ids?.includes(id),
  );
  const since = Math.max(...reopens.map((entry) => entry.id));
  const decisions = log.filter(
    (entry) => entry.id > since && entry.application_id === id && entry.action === "decision",
  );
  console.log(
    `Register: ${decisions.length} decision(s) and ${letters.length} letter(s) for ${id}. ` +
      "The goal is exactly 1 and 1.",
  );
}

async function kill() {
  const id = "HDC-2026-0142";
  await register("/admin/reopen", { ids: [id] });
  await register("/admin/chaos", { hold_letters_ms: 4000 });
  console.log(
    `Sending ${id}. The register will hold the letter call open, ` +
      "and the desk will be stopped while it waits.",
  );
  const pending = runApplication(id).catch(() => null);
  if (!(await waitForDecision(id))) {
    throw new Error("The desk never wrote a decision, so there was nothing to interrupt.");
  }
  const container = await deskContainer();
  await runCommand(["docker", "kill", container]);
  console.log("Decision written. Desk stopped before its letter was confirmed.");
  await register("/admin/chaos", { hold_letters_ms: null });
  await pending;
  await runCommand(["docker", "start", container]);
  await healthy(`${base}/healthz`, 30);
  console.log("Desk restarted. Waiting for it to finish what it started.");
  await Bun.sleep(5000);
  await countDecisionsAndLetters(id);
}

// Wait until Prometheus has seen the empty register, so an old alert cannot roll back the canary.
async function waitForNoAlerts() {
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`${URLS.prometheus}/api/v1/alerts`);
    const answer = (await response.json()) as { data: { alerts: unknown[] } };
    if (!answer.data.alerts.length) break;
    await Bun.sleep(1000);
  }
}

async function startCanary() {
  await resetWorld();
  await fetch(`${CONTROLLER}/reset`, { method: "POST" });
  await waitForNoAlerts();
  await fetch(`${CONTROLLER}/canary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ release: "v2", weight: 10 }),
  });
  console.log(
    "Release v2 is live as a canary on 10% of traffic. Sending residents' applications now. " +
      "Nobody touches the keyboard from here.",
  );
  await Bun.sleep(3000);
}

async function findRollback(): Promise<Rollback | undefined> {
  const response = await fetch(`${CONTROLLER}/state`);
  const state = (await response.json()) as { audit: Rollback[] };
  return state.audit.find((entry) => entry.action === "rollback");
}

function applicationIds(): string[] {
  const all = Array.from({ length: 40 }, (_, i) => `HDC-2026-0${140 + i}`);
  // The runaway application would slow every lap, so the traffic leaves it out.
  return all.filter((id) => id !== "HDC-2026-0177");
}

async function badCanary() {
  if (toDesk) {
    throw new Error(
      "bad-canary runs against the finished desk. Start it with: bun run up finished",
    );
  }
  await startCanary();
  const ids = applicationIds();
  const start = Date.now();
  let sent = 0;
  for (;;) {
    const id = ids[sent % ids.length];
    await register("/admin/reopen", { ids: [id] });
    await runApplication(id).catch(() => null);
    sent++;
    await Bun.sleep(100);
    const rollback = await findRollback();
    if (rollback) {
      console.log(
        `Alert ${rollback.alert} fired for release ${rollback.release}. ` +
          "The controller set the canary to 0%.",
      );
      console.log(
        `Rolled back ${secondsSince(start).toFixed(0)} s after the canary went live, ` +
          `after ${sent} applications, with no one at the keyboard.`,
      );
      return;
    }
    if (Date.now() - start > 180_000) {
      console.log(
        `No rollback within 3 minutes after ${sent} applications. ` +
          "Check http://localhost:9090/alerts.",
      );
      process.exit(1);
    }
    if (sent % 40 === 0) console.log(`  ${sent} applications sent, canary still live...`);
  }
}

async function checkReady() {
  if ((await gatewayProvider()) !== "replay") {
    throw new Error(
      "Chaos runs only with LLM_PROVIDER=replay, so it never spends real money. " +
        "Set it in .env and restart the world.",
    );
  }
  if (!(await healthy(`${base}/healthz`))) {
    const startCommand = toDesk ? "bun run up <step-name>" : "bun run up finished";
    throw new Error(`Nothing answers on ${base}. Start it first: ${startCommand}`);
  }
}

const FAULTS: Record<string, () => Promise<void>> = {
  runaway,
  kill,
  "bad-canary": badCanary,
};

try {
  await checkReady();
  const plant = Object.hasOwn(FAULTS, fault) ? FAULTS[fault] : undefined;
  if (!plant) {
    console.log(
      "Name a fault: bun run chaos runaway, bun run chaos kill, bun run chaos bad-canary",
    );
    process.exit(1);
  }
  await plant();
} catch (error) {
  console.log((error as Error).message);
  process.exit(2);
}

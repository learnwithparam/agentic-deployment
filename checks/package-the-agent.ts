// package-the-agent: the desk runs as a healthy, non-root container and streams each run as SSE.
import type { Rule } from "../scripts/verify";
import { container, deskService, exec, startDesk } from "./lib/desk";
import { dataField, hasDataField, postRun, type RunResult } from "./lib/sse";
import { application, letters, replayMode, resetWorld, URLS } from "./lib/world";

const APPS = ["HDC-2026-0142", "HDC-2026-0145", "HDC-2026-0150"];
const NO_ANSWER: RunResult = { status: 0, contentType: "", events: [], firstMs: null };
type HealthAnswer = { status?: unknown; version?: unknown };

async function runEachApplication(started: ReturnType<typeof startDesk>): Promise<RunResult[]> {
  if (!(await started).ok) return [];
  await resetWorld();
  const results: RunResult[] = [];
  for (const id of APPS) {
    results.push(await postRun(id).catch(() => ({ ...NO_ANSWER, events: [] })));
  }
  return results;
}

// The three runs happen once per started desk, and every rule below reads the same results.
const runs = new WeakMap<object, Promise<RunResult[]>>();
function threeRuns(dir: string): Promise<RunResult[]> {
  const started = startDesk(dir);
  let results = runs.get(started);
  if (!results) {
    results = runEachApplication(started);
    runs.set(started, results);
  }
  return results;
}

const streamsQuickly = (run: RunResult) =>
  run.contentType.includes("text/event-stream") && run.firstMs !== null && run.firstMs < 2000;

function streamsTokensThenDone(run: RunResult): boolean {
  const names = run.events.map((event) => event.event);
  const doneEvents = run.events.filter((event) => event.event === "done");
  const tokensFirst = names.includes("token") && names.indexOf("token") < names.indexOf("done");
  const oneDoneAtTheEnd = doneEvents.length === 1 && names.at(-1) === "done";
  if (!tokensFirst || !oneDoneAtTheEnd) return false;
  const done = doneEvents[0];
  return (
    typeof dataField(done, "run_id") === "string" &&
    dataField(done, "status") === "done" &&
    hasDataField(done, "cost_usd")
  );
}

async function eachRunLeftOneLetter(dir: string): Promise<boolean> {
  if ((await threeRuns(dir)).length !== 3) return false;
  for (const id of APPS) {
    if ((await application(id)).status === "received") return false;
    if ((await letters(id)).length !== 1) return false;
  }
  return true;
}

export default [
  {
    says: 'compose.yaml has a service named "desk" that builds this folder',
    test: async (dir) => Boolean((await deskService(dir))?.build),
    tryNext:
      'Add a "desk" service to compose.yaml with "build: { context: . }"' +
      " and a Dockerfile next to it.",
  },
  {
    says: "the image builds and the desk container reports healthy",
    test: async (dir) =>
      (await startDesk(dir)).ok && (await container())?.State?.Health?.Status === "healthy",
    tryNext:
      "Give the desk service a healthcheck that calls /healthz," +
      " then run bun run up package-the-agent and read the error it prints.",
  },
  {
    says: "the desk runs as a user that is not root",
    test: async (dir) => (await startDesk(dir)).ok && (await exec("id", "-u")).out.trim() !== "0",
    tryNext:
      "Add USER bun to the Dockerfile after the install step. The Bun image ships that user.",
  },
  {
    says: "GET /healthz answers 200 with status ok and the release version",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const response = await fetch(`${URLS.desk}/healthz`);
      const health = (await response.json()) as HealthAnswer;
      return response.status === 200 && health.status === "ok" && health.version === "v1";
    },
    tryNext:
      'Add app.get("/healthz") that returns { status: "ok", version: release.id }' +
      " without calling the model.",
  },
  {
    says:
      "POST /v1/runs answers with an event stream, first event within 2 seconds" +
      " (3 runs, replay mode)",
    test: async (dir) => {
      if (!(await replayMode())) return false;
      const results = await threeRuns(dir);
      return results.length === 3 && results.every(streamsQuickly);
    },
    tryNext:
      "Return streamSSE(c, ...) from hono/streaming and write an event before the first model" +
      " call. Check LLM_PROVIDER is replay.",
  },
  {
    says: "each stream sends token events, then one done event with run_id, status and cost_usd",
    test: async (dir) => {
      const results = await threeRuns(dir);
      return results.length === 3 && results.every(streamsTokensThenDone);
    },
    tryNext:
      "Write each agent event with stream.writeSSE({ event: type, data: JSON.stringify(rest) })." +
      ' The last one is "done".',
  },
  {
    says: "each run left its decision and exactly one letter in the register",
    test: eachRunLeftOneLetter,
    tryNext:
      "Open http://localhost:7001 to see the register. If nothing changed," +
      " read the desk's logs: docker compose -p hdc-desk logs desk.",
  },
  {
    says: "a run with no application_id gets a 400 answer, not a crash",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const response = await fetch(`${URLS.desk}/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.status === 400;
    },
    tryNext:
      "Check the body before you open the stream," +
      " and answer 400 with a message that shows the expected JSON.",
  },
] satisfies Rule[];

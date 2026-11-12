// biome-ignore-all lint/style/useNamingConvention: the desk's JSON uses names like application_id
// The finished permit desk: streamed runs, staff sign-in, a trace and a price for every run,
// three brakes, runs that survive a restart, a rate limit per resident and metrics by release.
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { endedRunCounts, newRun, runAgent } from "./agent";
import { bearerToken, exchangeCode, signInUrl, verify } from "./auth";
import { currentRelease, PORT, RATE_LIMIT, REGISTER_URL } from "./config";
import { residentPage, staffPage } from "./page";
import * as runs from "./runs";
import { provider } from "./telemetry";

type RunRequest = { application_id?: string };
type Application = { id: string; status: string };

const app = new Hono();

app.get("/", (context) => context.html(residentPage(currentRelease().id)));

// The container platform asks this to know the desk is alive. Keep it cheap: no model call.
app.get("/healthz", (context) => context.json({ status: "ok", version: currentRelease().id }));

// Rate limit: a few runs per resident in a short window.
// The start times of each resident's recent runs, by resident.
const recentRunStarts = new Map<string, number[]>();

// Answers how many seconds the resident must wait, or 0 when they may start a run now.
function secondsToWait(resident: string): number {
  const now = Date.now();
  const earlierStarts = recentRunStarts.get(resident) ?? [];
  const recent = earlierStarts.filter((startTime) => now - startTime < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.runs) {
    recentRunStarts.set(resident, recent);
    const oldestStart = recent[0];
    return Math.ceil((RATE_LIMIT.windowMs - (now - oldestStart)) / 1000);
  }
  recent.push(now);
  recentRunStarts.set(resident, recent);
  return 0;
}

// A resident is the x-resident-id header, else the first address in x-forwarded-for.
function residentOf(context: Context): string {
  const forwardedFor = context.req.header("x-forwarded-for");
  const firstAddress = forwardedFor?.split(",")[0].trim();
  return context.req.header("x-resident-id") ?? firstAddress ?? "local";
}

// Streams the run as Server-Sent Events, so the resident sees progress at once.
app.post("/v1/runs", async (context) => {
  // A body that is not JSON counts as an empty one, so the resident gets the 400 below.
  const request: RunRequest = await context.req.json().catch(() => ({}));
  const applicationId = request.application_id;
  if (!applicationId)
    return context.json({ error: 'send {"application_id": "HDC-2026-0142"}' }, 400);
  const wait = secondsToWait(residentOf(context));
  if (wait) {
    context.header("Retry-After", String(wait));
    const message = `Too many checks. Try again in ${wait} seconds.`;
    return context.json({ error: { code: "rate_limited", message } }, 429);
  }
  const run = newRun(applicationId, crypto.randomUUID());
  return streamSSE(context, async (stream) => {
    await stream.writeSSE({
      event: "token",
      data: JSON.stringify({ text: `Checking ${applicationId}. ` }),
    });
    for await (const event of runAgent(run)) {
      const { type, ...data } = event;
      await stream.writeSSE({ event: type, data: JSON.stringify(data) });
    }
  });
});

// What the desk knows about one run, for staff and for checks.
app.get("/v1/runs/:id", (context) => {
  const run = runs.get(context.req.param("id"));
  if (!run) return context.json({ error: "no such run" }, 404);
  return context.json({
    run_id: run.run_id,
    application_id: run.application_id,
    release: run.release_id,
    status: run.status,
    steps: run.steps,
    cost_usd: run.cost_usd,
  });
});

// Run counts in the Prometheus text format, so a dashboard can compare releases.
app.get("/metrics", (context) => {
  let metrics =
    "# HELP desk_runs_total Runs that ended, by release and status.\n" +
    "# TYPE desk_runs_total counter\n";
  for (const [countKey, count] of endedRunCounts) {
    const [releaseId, status] = countKey.split("|");
    metrics += `desk_runs_total{release="${releaseId}",status="${status}"} ${count}\n`;
  }
  return context.text(metrics);
});

// Staff pages. Only a signed-in officer may validate. The agent's own service identity may not.
// After sign-in, the browser keeps the signed token in this cookie and sends it with every page.
const SESSION_COOKIE = "desk_session";

async function applicationsAwaitingOfficer(): Promise<Application[]> {
  const response = await fetch(`${REGISTER_URL}/applications`);
  const applications = (await response.json()) as Application[];
  return applications.filter((application) => application.status === "valid_awaiting_officer");
}

// The register records which officer validated, so the decision has a name on it.
function validateInRegister(applicationId: string, officer: string): Promise<Response> {
  return fetch(`${REGISTER_URL}/applications/${encodeURIComponent(applicationId)}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": "permit-desk" },
    body: JSON.stringify({ officer }),
  });
}

app.get("/staff", async (context) => {
  const user = await verify(getCookie(context, SESSION_COOKIE));
  if (!user) return context.redirect(signInUrl(), 302);
  return context.html(staffPage(user.name, await applicationsAwaitingOfficer()));
});
// The sign-in service sends the browser back here with a one-time code.
app.get("/staff/callback", async (context) => {
  const token = await exchangeCode(context.req.query("code") ?? "");
  if (!token) return context.text("Sign-in failed. Try again from /staff.", 401);
  // httpOnly keeps the token away from scripts on the page.
  setCookie(context, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/" });
  return context.redirect("/staff", 302);
});
app.post("/staff/validate/:id", async (context) => {
  const user = await verify(getCookie(context, SESSION_COOKIE));
  if (!user) return context.redirect(signInUrl(), 302);
  if (!user.roles.includes("validation_officer"))
    return context.text("Only a validation officer can validate.", 403);
  await validateInRegister(context.req.param("id"), user.sub);
  return context.redirect("/staff", 303);
});
// The same action for programs, which send their token in the Authorization header.
app.post("/v1/applications/:id/validate", async (context) => {
  const user = await verify(bearerToken(context.req.header("authorization")));
  if (!user) {
    return context.json({ error: "sign in first: send Authorization: Bearer <token>" }, 401);
  }
  if (!user.roles.includes("validation_officer"))
    return context.json({ error: "only a validation officer can validate" }, 403);
  const response = await validateInRegister(context.req.param("id"), user.sub);
  // Pass the register's answer straight back, with its status code.
  return context.json(await response.json(), response.status as ContentfulStatusCode);
});

// Finish any run a restart cut short. Steps already in the journal are not sent to the model again.
async function finishRun(run: runs.Run) {
  // Nobody is watching this run, so its events are read and dropped.
  for await (const _event of runAgent(run)) {
  }
}
for (const run of runs.unfinished()) {
  console.log(`resuming run ${run.run_id} for ${run.application_id} at step ${run.steps}`);
  finishRun(run);
}
// Send the last spans to the trace desk before the container stops.
process.on("SIGTERM", async () => {
  await provider.forceFlush();
  process.exit(0);
});

// A run can take a minute or more, so the server keeps a quiet connection open for 120 seconds.
export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`permit desk ${currentRelease().id} listening on ${PORT}`);

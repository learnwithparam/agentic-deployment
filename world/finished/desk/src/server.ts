// The finished permit desk: streamed runs, staff sign-in, a trace and a price for every run, three brakes,
// runs that survive a restart, a rate limit per resident and metrics by release.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { type Event, finished, newRun, runAgent } from "./agent";
import { bearer, exchangeCode, signInUrl, verify } from "./auth";
import { currentRelease, PORT, RATE_LIMIT, REGISTER_URL } from "./config";
import { residentPage, staffPage } from "./page";
import * as runs from "./runs";
import { provider } from "./telemetry";

const app = new Hono();

app.get("/", (c) => c.html(residentPage(currentRelease().id)));
app.get("/healthz", (c) => c.json({ status: "ok", version: currentRelease().id }));

// Rate limit: a few runs per resident in a short window. A resident is the x-resident-id header, else the address.
const seen = new Map<string, number[]>();
function limited(who: string): number {
  const now = Date.now();
  const recent = (seen.get(who) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.runs) {
    seen.set(who, recent);
    return Math.ceil((RATE_LIMIT.windowMs - (now - recent[0])) / 1000);
  }
  recent.push(now);
  seen.set(who, recent);
  return 0;
}

app.post("/v1/runs", async (c) => {
  const { application_id } = await c.req.json().catch(() => ({}) as any);
  if (!application_id) return c.json({ error: 'send {"application_id": "HDC-2026-0142"}' }, 400);
  const who =
    c.req.header("x-resident-id") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "local";
  const wait = limited(who);
  if (wait) {
    c.header("Retry-After", String(wait));
    return c.json(
      {
        error: { code: "rate_limited", message: `Too many checks. Try again in ${wait} seconds.` },
      },
      429,
    );
  }
  const run = newRun(application_id, crypto.randomUUID());
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "token",
      data: JSON.stringify({ text: `Checking ${application_id}. ` }),
    });
    for await (const e of runAgent(run)) {
      const { type, ...data } = e as Event;
      await stream.writeSSE({ event: type, data: JSON.stringify(data) });
    }
  });
});

app.get("/v1/runs/:id", (c) => {
  const r = runs.get(c.req.param("id"));
  if (!r) return c.json({ error: "no such run" }, 404);
  return c.json({
    run_id: r.run_id,
    application_id: r.application_id,
    release: r.release_id,
    status: r.status,
    steps: r.steps,
    cost_usd: r.cost_usd,
  });
});

app.get("/metrics", (c) => {
  let out =
    "# HELP desk_runs_total Runs that ended, by release and status.\n# TYPE desk_runs_total counter\n";
  for (const [k, v] of finished) {
    const [rel, st] = k.split("|");
    out += `desk_runs_total{release="${rel}",status="${st}"} ${v}\n`;
  }
  return c.text(out);
});

// Staff pages. Only a signed-in officer may validate. The agent's own service identity may not.
const SESSION = "desk_session";
const queue = async () =>
  (
    (await (await fetch(`${REGISTER_URL}/applications`)).json()) as { id: string; status: string }[]
  ).filter((a) => a.status === "valid_awaiting_officer");
const validate = (id: string, officer: string) =>
  fetch(`${REGISTER_URL}/applications/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": "permit-desk" },
    body: JSON.stringify({ officer }),
  });
app.get("/staff", async (c) => {
  const user = await verify(getCookie(c, SESSION));
  if (!user) return c.redirect(signInUrl(), 302);
  return c.html(staffPage(user.name, await queue()));
});
app.get("/staff/callback", async (c) => {
  const token = await exchangeCode(c.req.query("code") ?? "");
  if (!token) return c.text("Sign-in failed. Try again from /staff.", 401);
  setCookie(c, SESSION, token, { httpOnly: true, sameSite: "Lax", path: "/" });
  return c.redirect("/staff", 302);
});
app.post("/staff/validate/:id", async (c) => {
  const user = await verify(getCookie(c, SESSION));
  if (!user) return c.redirect(signInUrl(), 302);
  if (!user.roles.includes("validation_officer"))
    return c.text("Only a validation officer can validate.", 403);
  await validate(c.req.param("id"), user.sub);
  return c.redirect("/staff", 303);
});
app.post("/v1/applications/:id/validate", async (c) => {
  const user = await verify(bearer(c.req.header("authorization")));
  if (!user) return c.json({ error: "sign in first: send Authorization: Bearer <token>" }, 401);
  if (!user.roles.includes("validation_officer"))
    return c.json({ error: "only a validation officer can validate" }, 403);
  const r = await validate(c.req.param("id"), user.sub);
  return c.json(await r.json(), r.status as any);
});

// Finish any run a restart cut short. Steps already in the journal are not sent to the model again.
for (const r of runs.unfinished()) {
  console.log(`resuming run ${r.run_id} for ${r.application_id} at step ${r.steps}`);
  (async () => {
    for await (const _ of runAgent(r)) {
    }
  })();
}
process.on("SIGTERM", async () => {
  await provider.forceFlush();
  process.exit(0);
});

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`permit desk ${currentRelease().id} listening on ${PORT}`);

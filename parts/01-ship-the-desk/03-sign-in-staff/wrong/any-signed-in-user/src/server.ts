// The permit desk's web service, ready to run in a container.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie } from "hono/cookie";
import { PORT, REGISTER_URL, release } from "./config";
import { runAgent } from "./agent";
import { bearer, exchangeCode, signInUrl, verify } from "./auth";
import { residentPage, staffPage } from "./page";

const app = new Hono();

app.get("/", (c) => c.html(residentPage(release.id)));

// The container platform asks this to know the desk is alive. Keep it cheap: no model call.
app.get("/healthz", (c) => c.json({ status: "ok", version: release.id }));

// Streams the run as Server-Sent Events, so the resident sees progress at once.
app.post("/v1/runs", async (c) => {
  const { application_id } = await c.req.json().catch(() => ({}) as any);
  if (!application_id) return c.json({ error: "send {\"application_id\": \"HDC-2026-0142\"}" }, 400);
  const runId = crypto.randomUUID();
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "token", data: JSON.stringify({ text: `Checking ${application_id}. ` }) });
    for await (const e of runAgent(application_id, runId)) {
      const { type, ...data } = e;
      await stream.writeSSE({ event: type, data: JSON.stringify(data) });
    }
  });
});

// Staff pages. Only a signed-in officer may validate. The agent's own service identity may not.
const SESSION = "desk_session";
const queue = async () =>
  ((await (await fetch(`${REGISTER_URL}/applications`)).json()) as { id: string; status: string }[]).filter((a) => a.status === "valid_awaiting_officer");
const validate = async (id: string, officer: string) =>
  fetch(`${REGISTER_URL}/applications/${encodeURIComponent(id)}/validate`, {
    method: "POST", headers: { "content-type": "application/json", "x-actor": "permit-desk" }, body: JSON.stringify({ officer }),
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
  await validate(c.req.param("id"), user.sub);
  return c.redirect("/staff", 303);
});
app.post("/v1/applications/:id/validate", async (c) => {
  const user = await verify(bearer(c.req.header("authorization")));
  if (!user) return c.json({ error: "sign in first: send Authorization: Bearer <token>" }, 401);
  const r = await validate(c.req.param("id"), user.sub);
  return c.json(await r.json(), r.status as any);
});

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`permit desk ${release.id} listening on ${PORT}`);

// The permit desk's web service, ready to run in a container.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { runAgent } from "./agent";
import { PORT, REGISTER_URL, release } from "./config";
import { residentPage, staffPage } from "./page";

const app = new Hono();

app.get("/", (c) => c.html(residentPage(release.id)));

// The container platform asks this to know the desk is alive. Keep it cheap: no model call.
app.get("/healthz", (c) => c.json({ status: "ok", version: release.id }));

// Streams the run as Server-Sent Events, so the resident sees progress at once.
app.post("/v1/runs", async (c) => {
  const { application_id } = await c.req.json().catch(() => ({}) as any);
  if (!application_id) return c.json({ error: 'send {"application_id": "HDC-2026-0142"}' }, 400);
  const runId = crypto.randomUUID();
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "token",
      data: JSON.stringify({ text: `Checking ${application_id}. ` }),
    });
    for await (const e of runAgent(application_id, runId)) {
      const { type, ...data } = e;
      await stream.writeSSE({ event: type, data: JSON.stringify(data) });
    }
  });
});

// Staff pages. Anyone can open them today.
app.get("/staff", async (c) => {
  const all = (await (await fetch(`${REGISTER_URL}/applications`)).json()) as {
    id: string;
    status: string;
  }[];
  return c.html(
    staffPage(
      "anyone (nobody checked)",
      all.filter((a) => a.status === "valid_awaiting_officer"),
    ),
  );
});
app.post("/v1/applications/:id/validate", async (c) => {
  const r = await fetch(`${REGISTER_URL}/applications/${c.req.param("id")}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": "permit-desk" },
    body: JSON.stringify({ officer: "unknown" }),
  });
  return c.json(await r.json(), r.status as any);
});

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`permit desk ${release.id} listening on ${PORT}`);

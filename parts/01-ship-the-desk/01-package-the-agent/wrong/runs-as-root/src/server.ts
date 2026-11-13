// biome-ignore-all lint/style/useNamingConvention: the desk's JSON uses names like application_id
// The permit desk's web service, ready to run in a container.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { runAgent } from "./agent";
import { PORT, REGISTER_URL, release } from "./config";
import { residentPage, staffPage } from "./page";

type RunRequest = { application_id?: string };
type Application = { id: string; status: string };

const app = new Hono();

app.get("/", (context) => context.html(residentPage(release.id)));

// The container platform asks this to know the desk is alive. Keep it cheap: no model call.
app.get("/healthz", (context) => context.json({ status: "ok", version: release.id }));

// Streams the run as Server-Sent Events, so the resident sees progress at once.
app.post("/v1/runs", async (context) => {
  // A body that is not JSON counts as an empty one, so the resident gets the 400 below.
  const request: RunRequest = await context.req.json().catch(() => ({}));
  const applicationId = request.application_id;
  if (!applicationId)
    return context.json({ error: 'send {"application_id": "HDC-2026-0142"}' }, 400);
  const runId = crypto.randomUUID();
  return streamSSE(context, async (stream) => {
    await stream.writeSSE({
      event: "token",
      data: JSON.stringify({ text: `Checking ${applicationId}. ` }),
    });
    for await (const event of runAgent(applicationId, runId)) {
      const { type, ...data } = event;
      await stream.writeSSE({ event: type, data: JSON.stringify(data) });
    }
  });
});

// Staff pages. Anyone can open them today.
app.get("/staff", async (context) => {
  const response = await fetch(`${REGISTER_URL}/applications`);
  const applications = (await response.json()) as Application[];
  const waiting = applications.filter(
    (application) => application.status === "valid_awaiting_officer",
  );
  return context.html(staffPage("anyone (nobody checked)", waiting));
});
app.post("/v1/applications/:id/validate", async (context) => {
  const applicationId = context.req.param("id");
  const response = await fetch(`${REGISTER_URL}/applications/${applicationId}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": "permit-desk" },
    body: JSON.stringify({ officer: "unknown" }),
  });
  // Pass the register's answer straight back, with its status code.
  return context.json(await response.json(), response.status as ContentfulStatusCode);
});

// A run can take a minute or more, so the server keeps a quiet connection open for 120 seconds.
export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`permit desk ${release.id} listening on ${PORT}`);

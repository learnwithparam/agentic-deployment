// biome-ignore-all lint/style/useNamingConvention: the desk's JSON uses names like application_id
// The permit desk's web service. Today it runs on one laptop with `bun src/server.ts`.
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Event, runAgent } from "./agent";
import { PORT, REGISTER_URL, release } from "./config";
import { residentPage, staffPage } from "./page";

type RunRequest = { application_id?: string };
type Application = { id: string; status: string };

const app = new Hono();

app.get("/", (context) => context.html(residentPage(release.id)));

// Runs the agent to the end, then answers with everything at once.
app.post("/v1/runs", async (context) => {
  // A body that is not JSON counts as an empty one, so the resident gets the 400 below.
  const request: RunRequest = await context.req.json().catch(() => ({}));
  const applicationId = request.application_id;
  if (!applicationId)
    return context.json({ error: 'send {"application_id": "HDC-2026-0142"}' }, 400);
  const runId = crypto.randomUUID();
  const events: Event[] = [];
  for await (const event of runAgent(applicationId, runId)) events.push(event);
  return context.json({ run_id: runId, events });
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

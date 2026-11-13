// biome-ignore-all lint/style/useNamingConvention: the desk's JSON uses names like application_id
// The permit desk's web service, ready to run in a container.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { runAgent } from "./agent";
import { bearerToken, exchangeCode, signInUrl, verify } from "./auth";
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

// A run can take a minute or more, so the server keeps a quiet connection open for 120 seconds.
export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`permit desk ${release.id} listening on ${PORT}`);

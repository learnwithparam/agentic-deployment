// sign-in-staff: staff sign in through the council's sign-in service; only a validation officer may validate.
import type { Rule } from "../scripts/verify";
import { startDesk } from "./lib/desk";
import { URLS, resetWorld, setStatus, application, tokenFor, serviceToken, forgedToken, secret } from "./lib/world";

const APP = "HDC-2026-0151";
const validate = (token?: string) =>
  fetch(`${URLS.desk}/v1/applications/${APP}/validate`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "manual" });

// One scenario per desk: an application waits for an officer, then each caller tries to validate it.
const scenarios = new WeakMap<object, Promise<Record<string, number> | null>>();
function scenario(dir: string) {
  const started = startDesk(dir);
  if (!scenarios.has(started)) scenarios.set(started, (async () => {
    if (!(await started).ok) return null;
    await resetWorld();
    await setStatus(APP, "valid_awaiting_officer");
    const out: Record<string, number> = {};
    out.none = (await validate()).status;
    out.forged = (await validate(await forgedToken())).status;
    out.resident = (await validate(await tokenFor("sam.hollis"))).status;
    out.agent = (await validate(await serviceToken())).status;
    out.statusBeforeOfficer = (await application(APP)).status === "valid_awaiting_officer" ? 1 : 0;
    out.officer = (await validate(await tokenFor("amara.okafor"))).status;
    return out;
  })());
  return scenarios.get(started)!;
}

async function browserSignIn(): Promise<boolean> {
  const first = await fetch(`${URLS.desk}/staff`, { redirect: "manual" });
  const loc = first.headers.get("location") ?? "";
  if (![302, 303].includes(first.status) || !loc.startsWith(`${URLS.idp}/authorize`)) return false;
  const q = new URL(loc).searchParams;
  const pw = JSON.parse(secret("passwords"))["amara.okafor"];
  const form = new URLSearchParams([...q, ["username", "amara.okafor"], ["password", pw]]);
  const back = await fetch(`${URLS.idp}/authorize`, { method: "POST", body: form, redirect: "manual" });
  const cb = back.headers.get("location") ?? "";
  if (!cb.startsWith(`${URLS.desk}/staff/callback`)) return false;
  const done = await fetch(cb, { redirect: "manual" });
  const cookie = (done.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) return false;
  const page = await fetch(`${URLS.desk}/staff`, { headers: { cookie }, redirect: "manual" });
  return page.status === 200 && (await page.text()).includes("Amara Okafor");
}

export default [
  {
    says: "GET /staff with no session sends the browser to the council's sign-in page",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const r = await fetch(`${URLS.desk}/staff`, { redirect: "manual" });
      const loc = r.headers.get("location") ?? "";
      return [302, 303].includes(r.status) && loc.startsWith(`${URLS.idp}/authorize`) && loc.includes("client_id=permit-desk");
    },
    tryNext: "In the /staff route, call verify on the session cookie. When it returns null, return c.redirect(signInUrl(), 302).",
  },
  {
    says: "an officer who signs in on that page lands on the validation queue with their name",
    test: async (dir) => (await startDesk(dir)).ok && (await browserSignIn()),
    tryNext: "Add /staff/callback: swap the code with exchangeCode, store the token in an httpOnly cookie, then redirect to /staff.",
  },
  {
    says: "validate with no token answers 401, and with a forged token answers 401",
    test: async (dir) => { const s = await scenario(dir); return s?.none === 401 && s?.forged === 401; },
    tryNext: "verify must check the signature against the sign-in service's keys (jwtVerify with createRemoteJWKSet), not only read the claims.",
  },
  {
    says: "a signed-in resident gets 403 on validate",
    test: async (dir) => (await scenario(dir))?.resident === 403,
    tryNext: 'A valid token is not enough. Check user.roles includes "validation_officer" and answer 403 when it does not.',
  },
  {
    says: "the agent's own service identity gets 403 on validate",
    test: async (dir) => (await scenario(dir))?.agent === 403,
    tryNext: 'The desk\'s client_credentials token carries the role "agent". Only "validation_officer" may validate.',
  },
  {
    says: "the register was untouched by every refused call, and an officer's call validates it",
    test: async (dir) => { const s = await scenario(dir); return s?.statusBeforeOfficer === 1 && s?.officer === 200 && (await application(APP)).status === "validated"; },
    tryNext: "Return before you call the register when a check fails. For an officer, pass user.sub as the officer.",
  },
] satisfies Rule[];

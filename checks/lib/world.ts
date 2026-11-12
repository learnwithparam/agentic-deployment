// Read the world's state for a check: the register, the letters, the audit log, the gateway's spend log,
// the trace desk's spans and tokens from the sign-in service. Checks read state, never the model's reply.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URLS, ROOT, SECRETS, secret, startWorld, resetWorld, admin, gatewayProvider } from "../../world/cli/lib";
import { applications, expected, type Application } from "../../world/register/rules";

export { URLS, ROOT, secret, resetWorld, applications, expected };
export type { Application };

let ready: Promise<void> | null = null;
/** Start the world once per check run. Throws with a plain sentence when Docker or a port is the problem. */
export function world(): Promise<void> {
  ready ??= startWorld(() => {});
  return ready;
}

/** Model-dependent rules run in replay mode, so they give the same result on every machine. */
export async function replayMode(): Promise<boolean> {
  await world();
  return (await gatewayProvider()) === "replay";
}

const get = async (path: string) => (await fetch(`${URLS.register}${path}`)).json() as Promise<any>;
export const application = (id: string) => get(`/applications/${id}`);
export const letters = (id: string): Promise<any[]> => get(`/letters?application_id=${id}`);
export const audit = (): Promise<any[]> => get(`/audit`);
export const spend = (): Promise<any[]> => admin("/admin/spend");
export const spans = async (): Promise<any[]> => (await fetch(`${URLS.traces}/api/spans`)).json() as Promise<any[]>;

/** Force a status into the register, the way an earlier run would have, to set up a scenario. */
export async function setStatus(id: string, status: string) {
  return fetch(`${URLS.register}/applications/${id}/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-actor": "check-setup", "x-release": "setup" },
    body: JSON.stringify({ status, missing_items: [] }),
  });
}

/** A real token for a seeded person, from the sign-in service. */
export async function tokenFor(username: string): Promise<string> {
  const pw = JSON.parse(readFileSync(join(SECRETS, "passwords"), "utf8"))[username];
  const r = await fetch(`${URLS.idp}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "password", username, password: pw }) });
  return ((await r.json()) as any).access_token;
}

/** The desk's own service identity: a client_credentials token with the "agent" role. */
export async function serviceToken(): Promise<string> {
  const r = await fetch(`${URLS.idp}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "permit-desk", client_secret: secret("desk_client_secret") }),
  });
  return ((await r.json()) as any).access_token;
}

/** A token that claims to be an officer but is signed with a key the council never issued. */
export async function forgedToken(): Promise<string> {
  const { privateKey } = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const b64 = (x: string | Uint8Array) => Buffer.from(x).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", kid: "forged" }));
  const body = b64(JSON.stringify({ iss: "http://localhost:7003", aud: "permit-desk", sub: "mallory", name: "Mallory", roles: ["validation_officer"], iat: now, exp: now + 600 }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64(sig)}`;
}

export const root = ROOT;

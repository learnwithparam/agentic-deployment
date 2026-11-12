// biome-ignore-all lint/style/useNamingConvention: the world's JSON and OAuth forms use snake_case names like run_id and grant_type, and we keep them exactly
// Read the world's state for a check: the register, the letters, the audit log, the gateway's
// spend log, the trace desk's spans and tokens from the sign-in service. Checks read state,
// never the model's reply.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  admin,
  gatewayProvider,
  ROOT,
  resetWorld,
  SECRETS,
  secret,
  startWorld,
  URLS,
} from "../../world/cli/lib";
import { type Application, applications, expected } from "../../world/register/rules";

export type { Application };
export { applications, expected, ROOT, resetWorld, secret, URLS };

/** One application as the register stores it. Checks only read its status. */
export type RegisterApplication = { status: string; [field: string]: unknown };
/** A letter or an audit entry from the register. Checks only count them. */
export type RegisterRecord = Record<string, unknown>;
/** One row of the gateway's spend log: which key paid for which run. */
export type SpendRow = { run_id: string; key: string; [field: string]: unknown };
/** One span from the trace desk. */
export type Span = {
  name: string;
  trace_id: string;
  parent_span_id?: string | null;
  start_ms: number;
  attributes: Record<string, unknown>;
};
type TokenAnswer = { access_token: string };

let ready: Promise<void> | null = null;
/** Start the world once per check run. Throws a plain sentence when Docker or a port fails. */
export function world(): Promise<void> {
  ready ??= startWorld(() => {});
  return ready;
}

/** Model-dependent rules run in replay mode, so they give the same result on every machine. */
export async function replayMode(): Promise<boolean> {
  await world();
  return (await gatewayProvider()) === "replay";
}

async function fromRegister<Answer>(path: string): Promise<Answer> {
  const response = await fetch(`${URLS.register}${path}`);
  return (await response.json()) as Answer;
}
export const application = (id: string) => fromRegister<RegisterApplication>(`/applications/${id}`);
export const letters = (id: string) =>
  fromRegister<RegisterRecord[]>(`/letters?application_id=${id}`);
export const audit = () => fromRegister<RegisterRecord[]>("/audit");
export const spend = () => admin<SpendRow[]>("/admin/spend");
export async function spans(): Promise<Span[]> {
  const response = await fetch(`${URLS.traces}/api/spans`);
  return (await response.json()) as Span[];
}

/** Force a status into the register, the way an earlier run would have, to set up a scenario. */
export async function setStatus(id: string, status: string) {
  return fetch(`${URLS.register}/applications/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": "check-setup", "x-release": "setup" },
    body: JSON.stringify({ status, missing_items: [] }),
  });
}

async function tokenFromForm(form: Record<string, string>): Promise<string> {
  const response = await fetch(`${URLS.idp}/token`, {
    method: "POST",
    body: new URLSearchParams(form),
  });
  const answer = (await response.json()) as TokenAnswer;
  return answer.access_token;
}

/** A real token for a seeded person, from the sign-in service. */
export function tokenFor(username: string): Promise<string> {
  const passwords = JSON.parse(readFileSync(join(SECRETS, "passwords"), "utf8"));
  const password = passwords[username];
  return tokenFromForm({ grant_type: "password", username, password });
}

/** The desk's own service identity: a client_credentials token with the "agent" role. */
export function serviceToken(): Promise<string> {
  return tokenFromForm({
    grant_type: "client_credentials",
    client_id: "permit-desk",
    client_secret: secret("desk_client_secret"),
  });
}

const base64Url = (content: string | Uint8Array) => Buffer.from(content).toString("base64url");

/** A token that claims to be an officer but is signed with a key the council never issued. */
export async function forgedToken(): Promise<string> {
  const { privateKey } = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: "forged" }));
  const claims = base64Url(
    JSON.stringify({
      iss: "http://localhost:7003",
      aud: "permit-desk",
      sub: "mallory",
      name: "Mallory",
      roles: ["validation_officer"],
      iat: now,
      exp: now + 600,
    }),
  );
  const signedPart = new TextEncoder().encode(`${header}.${claims}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signedPart);
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

export const root = ROOT;

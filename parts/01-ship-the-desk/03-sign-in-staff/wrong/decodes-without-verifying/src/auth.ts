// Sign-in for staff, with the council's sign-in service (OpenID Connect).

import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";
import { IDP_URL, ISSUER, PUBLIC_URL } from "./config";

export type User = { sub: string; name: string; roles: string[] };
const CLIENT_ID = "permit-desk";
const REDIRECT = `${PUBLIC_URL}/staff/callback`;
const clientSecret = () =>
  readFileSync(process.env.CLIENT_SECRET_FILE ?? "/run/secrets/desk_client_secret", "utf8").trim();

export const bearer = (h?: string) => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

export function signInUrl(): string {
  const u = new URL(`${ISSUER}/authorize`);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid");
  u.searchParams.set("state", crypto.randomUUID());
  return u.toString();
}

export async function exchangeCode(code: string): Promise<string | null> {
  const r = await fetch(`${IDP_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      client_secret: clientSecret(),
    }),
  });
  return r.ok ? ((await r.json()) as any).id_token : null;
}

// The mistake: read the claims without checking who signed them. Anyone can write a token like this.
export async function verify(token?: string): Promise<User | null> {
  if (!token) return null;
  try {
    const payload = decodeJwt(token);
    if ((payload.exp ?? 0) * 1000 < Date.now()) return null;
    return {
      sub: String(payload.sub),
      name: String(payload.name ?? payload.sub),
      roles: (payload.roles as string[]) ?? [],
    };
  } catch {
    return null;
  }
}

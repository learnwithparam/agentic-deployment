// Sign-in for staff, with the council's sign-in service (OpenID Connect).
// signInUrl and exchangeCode are done. verify is yours.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { readFileSync } from "node:fs";
import { IDP_URL, ISSUER, PUBLIC_URL } from "./config";

export type User = { sub: string; name: string; roles: string[] };
const CLIENT_ID = "permit-desk";
const REDIRECT = `${PUBLIC_URL}/staff/callback`;
const clientSecret = () => readFileSync(process.env.CLIENT_SECRET_FILE ?? "/run/secrets/desk_client_secret", "utf8").trim();

// The sign-in service publishes its public keys here. jose fetches and caches them.
const keys = createRemoteJWKSet(new URL(`${IDP_URL}/jwks`));

export const bearer = (h?: string) => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

/** Where to send a browser that is not signed in. */
export function signInUrl(): string {
  const u = new URL(`${ISSUER}/authorize`);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid");
  u.searchParams.set("state", crypto.randomUUID());
  return u.toString();
}

/** Swap the one-time code from the callback for a token. */
export async function exchangeCode(code: string): Promise<string | null> {
  const r = await fetch(`${IDP_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, client_secret: clientSecret() }),
  });
  return r.ok ? ((await r.json()) as any).id_token : null;
}

/** A user if the token is signed by the council, not expired, and meant for this desk. Otherwise null. */
export async function verify(token?: string): Promise<User | null> {
  // TODO: check the signature with `keys`, the issuer (ISSUER) and the audience (CLIENT_ID), using jwtVerify.
  // Return { sub, name, roles } from the payload, or null when anything is wrong.
  void token; void jwtVerify; void keys;
  throw new Error("Not implemented: verify the token in src/auth.ts");
}

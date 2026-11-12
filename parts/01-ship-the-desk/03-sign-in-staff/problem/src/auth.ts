// biome-ignore-all lint/style/useNamingConvention: OpenID Connect names fields like client_id
// Sign-in for staff, with the council's sign-in service (OpenID Connect).
// signInUrl and exchangeCode are done. verify is yours.

import { readFileSync } from "node:fs";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { IDP_URL, ISSUER, PUBLIC_URL } from "./config";

// sub is the user's id in the sign-in service: the name OpenID Connect gives it in every token.
export type User = { sub: string; name: string; roles: string[] };

// The token endpoint's answer. The id_token says who signed in.
type TokenAnswer = { id_token: string };

const CLIENT_ID = "permit-desk";
const REDIRECT_URI = `${PUBLIC_URL}/staff/callback`;

// Read the secret only at sign-in, so residents are served even when staff sign-in is not set up.
function clientSecret(): string {
  const secretFile = process.env.CLIENT_SECRET_FILE ?? "/run/secrets/desk_client_secret";
  return readFileSync(secretFile, "utf8").trim();
}

// The sign-in service publishes its public keys here. jose fetches and caches them.
const keys = createRemoteJWKSet(new URL(`${IDP_URL}/jwks`));

/** The token from an "Authorization: Bearer <token>" header, if there is one. */
export function bearerToken(header?: string): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/** Where to send a browser that is not signed in. */
export function signInUrl(): string {
  const signIn = new URL(`${ISSUER}/authorize`);
  signIn.searchParams.set("client_id", CLIENT_ID);
  signIn.searchParams.set("redirect_uri", REDIRECT_URI);
  signIn.searchParams.set("response_type", "code");
  signIn.searchParams.set("scope", "openid");
  signIn.searchParams.set("state", crypto.randomUUID());
  return signIn.toString();
}

/** Swap the one-time code from the callback for a token. */
export async function exchangeCode(code: string): Promise<string | null> {
  const response = await fetch(`${IDP_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: clientSecret(),
    }),
  });
  if (!response.ok) return null;
  const answer = (await response.json()) as TokenAnswer;
  return answer.id_token;
}

/**
 * A user if the token is signed by the council, not expired, and meant for this desk.
 * Otherwise null.
 */
export async function verify(token?: string): Promise<User | null> {
  // TODO: check the signature with `keys`, the issuer (ISSUER) and the audience (CLIENT_ID),
  // using jwtVerify. Return { sub, name, roles } from the payload, or null when anything is wrong.
  void token;
  void jwtVerify;
  void keys;
  throw new Error("Not implemented: verify the token in src/auth.ts");
}

// biome-ignore-all lint/style/useNamingConvention: OAuth fields stay snake_case
// The desk's side of sign-in with Keycloak: send the browser to the realm, swap the code for a
// token, check a token with the realm's keys, and narrow a token for one service.
import { readFileSync } from "node:fs";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import * as client from "openid-client";

export const ISSUER = process.env.ISSUER ?? "http://localhost:8180/realms/council";
export const DESK_CLIENT = "permit-desk";
export const DESK_SERVER = "permit-desk-server";
export const SERVICE_CLIENT = "permit-service";
const CALLBACK = "http://localhost:3000/staff/callback";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

// Keycloak runs on plain http in this course, so the library must be told that is on purpose.
const realm = await client.discovery(new URL(ISSUER), DESK_CLIENT, undefined, client.None(), {
  execute: [client.allowInsecureRequests],
});
// The desk's server proves who it is with a secret that lives in a file, never in the code.
const secretFile = process.env.DESK_CLIENT_SECRET_FILE ?? "/run/secrets/desk_client_secret";
const serverRealm = await client.discovery(
  new URL(ISSUER),
  DESK_SERVER,
  undefined,
  client.ClientSecretPost(readFileSync(secretFile, "utf8").trim()),
  { execute: [client.allowInsecureRequests] },
);
const keys = createRemoteJWKSet(new URL(realm.serverMetadata().jwks_uri as string));

/** What the desk keeps between sending the browser away and getting it back. */
export type SignIn = { url: string; verifier: string; state: string };

/** The realm's sign-in page, with a PKCE challenge so a stolen code is useless. */
export async function startSignIn(): Promise<SignIn> {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(realm, {
    redirect_uri: CALLBACK,
    scope: "openid",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  return { url: url.href, verifier, state };
}

/** Swap the code on the callback address for the staff member's access token. */
export async function finishSignIn(callbackUrl: string, saved: SignIn): Promise<string> {
  const tokens = await client.authorizationCodeGrant(realm, new URL(callbackUrl), {
    pkceCodeVerifier: saved.verifier,
    expectedState: saved.state,
  });
  return tokens.access_token;
}

/** The token's claims when the realm signed it for this audience and it has not expired. */
export async function verifyToken(token: string, audience: string): Promise<JWTPayload> {
  const checked = await jwtVerify(token, keys, { issuer: ISSUER, audience });
  return checked.payload;
}

/** Trade the staff token for one that only the service client accepts. */
export async function narrowToken(staffToken: string): Promise<string> {
  const narrowed = await client.genericGrantRequest(serverRealm, TOKEN_EXCHANGE, {
    subject_token: staffToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience: SERVICE_CLIENT,
  });
  return narrowed.access_token;
}

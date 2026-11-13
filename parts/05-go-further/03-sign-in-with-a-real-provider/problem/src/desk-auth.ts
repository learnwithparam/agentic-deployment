// The desk's side of sign-in with Keycloak: send the browser to the realm, swap the code for a
// token, check a token with the realm's keys, and narrow a token for one service.
// Start from the sample in ../solution/src/desk-auth.ts only when you are stuck.
import type { JWTPayload } from "jose";

export const ISSUER = process.env.ISSUER ?? "http://localhost:8180/realms/council";
export const DESK_CLIENT = "permit-desk";
export const DESK_SERVER = "permit-desk-server";
export const SERVICE_CLIENT = "permit-service";

/** What the desk keeps between sending the browser away and getting it back. */
export type SignIn = { url: string; verifier: string; state: string };

/** The realm's sign-in page, with a PKCE challenge so a stolen code is useless. */
export async function startSignIn(): Promise<SignIn> {
  // TODO: build the authorization URL with client.buildAuthorizationUrl and an S256 challenge.
  throw new Error("startSignIn is not written yet");
}

/** Swap the code on the callback address for the staff member's access token. */
export async function finishSignIn(callbackUrl: string, saved: SignIn): Promise<string> {
  // TODO: client.authorizationCodeGrant with the saved verifier and state.
  throw new Error("finishSignIn is not written yet");
}

/** The token's claims when the realm signed it for this audience and it has not expired. */
export async function verifyToken(token: string, audience: string): Promise<JWTPayload> {
  // TODO: jwtVerify with the realm's keys, its issuer and the audience.
  throw new Error("verifyToken is not written yet");
}

/** Trade the staff token for one that only the service client accepts. */
export async function narrowToken(staffToken: string): Promise<string> {
  // TODO: client.genericGrantRequest with the token-exchange grant and audience permit-service.
  throw new Error("narrowToken is not written yet");
}

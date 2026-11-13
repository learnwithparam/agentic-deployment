// sign-in-with-a-real-provider: the council's sign-in is a Keycloak realm. The desk signs staff in
// with the authorization code flow and PKCE, checks every token with the realm's keys, and trades
// a staff token for one that only the service accepts.
import type { Rule } from "../scripts/verify";
import {
  type DeskAuth,
  DISCOVERY,
  loadDeskAuth,
  officerToken,
  REALM_URL,
  refusesWithoutPkce,
  setTokenSeconds,
  startKeycloak,
} from "./lib/keycloak";

const DESK_SERVER = "permit-desk-server";
const SERVICE = "permit-service";

/** True when verifying the token for this audience throws, as it must for a bad token. */
async function refused(auth: DeskAuth, token: string, audience: string): Promise<boolean> {
  try {
    await auth.verifyToken(token, audience);
    return false;
  } catch {
    return true;
  }
}

/** True when verifying the token for this audience gives back claims. */
async function accepted(auth: DeskAuth, token: string, audience: string): Promise<boolean> {
  try {
    return Boolean(await auth.verifyToken(token, audience));
  } catch {
    return false;
  }
}

type Scenario = { auth: DeskAuth; staff: string; narrowed: string };

// One scenario per folder: Keycloak starts, the officer signs in, and the desk narrows the token.
const scenarios = new Map<string, Promise<Scenario | null>>();

async function playScenario(dir: string): Promise<Scenario | null> {
  if (!(await startKeycloak(dir))) return null;
  const auth = await loadDeskAuth(dir);
  if (!auth) return null;
  const staff = await officerToken(auth);
  const narrowed = await auth.narrowToken(staff);
  return { auth, staff, narrowed };
}

function scenario(dir: string): Promise<Scenario | null> {
  let played = scenarios.get(dir);
  if (!played) {
    played = playScenario(dir).catch(() => null);
    scenarios.set(dir, played);
  }
  return played;
}

// A token that really was signed by the realm, and has lived past its expiry.
async function expiredToken(dir: string): Promise<{ auth: DeskAuth; token: string } | null> {
  if (!(await startKeycloak(dir))) return null;
  const auth = await loadDeskAuth(dir);
  if (!auth) return null;
  await setTokenSeconds(2);
  try {
    const token = await officerToken(auth);
    await Bun.sleep(3500);
    return { auth, token };
  } finally {
    await setTokenSeconds(300);
  }
}

export default [
  {
    says: "the realm's discovery document answers with its issuer, keys and token address",
    test: async (dir) => {
      if (!(await startKeycloak(dir))) return false;
      const response = await fetch(DISCOVERY);
      const found = (await response.json()) as Record<string, string>;
      const hasAddresses = Boolean(found.jwks_uri && found.token_endpoint);
      return response.ok && found.issuer === REALM_URL && hasAddresses;
    },
    tryNext:
      "Add a keycloak service to compose.yaml: image keycloak/keycloak:26.8.2, the realm folder" +
      " mounted at /opt/keycloak/data/import, and kc.sh start-dev --import-realm.",
  },
  {
    says: "the realm refuses a sign-in request that has no PKCE challenge",
    test: async (dir) => (await startKeycloak(dir)) && (await refusesWithoutPkce()),
    tryNext:
      'In the permit-desk client, set the attribute "pkce.code.challenge.method" to "S256"' +
      " so the realm requires a challenge.",
  },
  {
    says: "a token from the officer's sign-in with the code flow is accepted by the desk",
    test: async (dir) => {
      const played = await scenario(dir);
      if (!played) return false;
      const claims = await played.auth.verifyToken(played.staff, DESK_SERVER);
      const roles = (claims.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
      return roles.includes("validation_officer");
    },
    tryNext:
      "In startSignIn send code_challenge with method S256, and in finishSignIn pass the saved" +
      " verifier. Then verifyToken with jwtVerify, the realm's keys and its issuer.",
  },
  {
    says: "an expired token and a token for another audience are refused",
    test: async (dir) => {
      const played = await scenario(dir);
      const old = await expiredToken(dir);
      if (!played || !old) return false;
      const expiredRefused = await refused(old.auth, old.token, DESK_SERVER);
      const otherAudienceRefused = await refused(played.auth, played.staff, "another-service");
      return expiredRefused && otherAudienceRefused;
    },
    tryNext:
      "Pass the audience you expect to jwtVerify. It then refuses a token made for someone else." +
      " It refuses an expired token on its own, so do not set a clock tolerance.",
  },
  {
    says: "the narrowed token is accepted by the service and refused by the desk's own audience",
    test: async (dir) => {
      const played = await scenario(dir);
      if (!played) return false;
      const forService = await accepted(played.auth, played.narrowed, SERVICE);
      const forDesk = await refused(played.auth, played.narrowed, DESK_SERVER);
      return played.narrowed !== played.staff && forService && forDesk;
    },
    tryNext:
      "narrowToken must send a token-exchange request with audience permit-service, using the" +
      " desk server's own secret, and return the new access token, not the staff token.",
  },
] satisfies Rule[];

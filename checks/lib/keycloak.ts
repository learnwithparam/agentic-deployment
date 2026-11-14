// biome-ignore-all lint/style/useNamingConvention: OAuth and compose fields stay as they are named
// Helpers for the sign-in-with-keycloak check: start Keycloak from a folder, sign in as the
// officer the way a browser does, and load the folder's own desk-auth module.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  composeEnv,
  ensureSecrets,
  healthy,
  runCommand,
  SECRETS,
  secret,
} from "../../world/cli/lib";

export const PROJECT = "hdc-keycloak";
export const REALM_URL = "http://localhost:8180/realms/council";
export const DISCOVERY = `${REALM_URL}/.well-known/openid-configuration`;

const compose = (dir: string, ...args: string[]) =>
  runCommand(["docker", "compose", "-p", PROJECT, "-f", join(dir, "compose.yaml"), ...args], {
    env: composeEnv(),
    cwd: dir,
  });

let started: { dir: string; ok: Promise<boolean> } | null = null;

async function startNow(dir: string): Promise<boolean> {
  ensureSecrets();
  await compose(dir, "down", "-v", "--remove-orphans", "--timeout", "2");
  if (!existsSync(join(dir, "compose.yaml"))) return false;
  const composeUp = await compose(dir, "up", "-d", "--wait", "--wait-timeout", "180");
  return composeUp.code === 0 && (await healthy(DISCOVERY, 30));
}

/** Start Keycloak from this folder once per check run, and remove it with its data on exit. */
export function startKeycloak(dir: string): Promise<boolean> {
  if (started?.dir === dir) return started.ok;
  const ok = startNow(dir);
  started = { dir, ok };
  process.on("exit", () => {
    const takeDown = ["docker", "compose", "-p", PROJECT, "-f", join(dir, "compose.yaml")];
    Bun.spawnSync([...takeDown, "down", "-v", "--timeout", "2"], {
      env: { ...process.env, ...composeEnv() },
      cwd: dir,
    });
  });
  return ok;
}

/** What the desk module exports, as the checks call it. */
export type DeskAuth = {
  startSignIn: () => Promise<{ url: string; verifier: string; state: string }>;
  finishSignIn: (callbackUrl: string, saved: unknown) => Promise<string>;
  verifyToken: (token: string, audience: string) => Promise<Record<string, unknown>>;
  narrowToken: (staffToken: string) => Promise<string>;
};

/** Load the folder's desk module, or null when it is missing or will not load. */
export async function loadDeskAuth(dir: string): Promise<DeskAuth | null> {
  const file = join(dir, "src", "desk-auth.ts");
  if (!existsSync(file)) return null;
  process.env.DESK_CLIENT_SECRET_FILE ??= join(SECRETS, "desk_client_secret");
  try {
    return (await import(file)) as DeskAuth;
  } catch {
    return null;
  }
}

const CAPTURED = /action="([^"]+)"/;

/** Sign in as the officer on the realm's own page, as a browser would, and return the token. */
export async function officerToken(auth: DeskAuth): Promise<string> {
  const saved = await auth.startSignIn();
  const page = await fetch(saved.url, { redirect: "manual" });
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
  const html = await page.text();
  const action = html.match(CAPTURED)?.[1]?.replaceAll("&amp;", "&");
  if (!action) throw new Error("the realm showed no sign-in form");
  const form = new URLSearchParams({
    username: "amara.okafor",
    password: secret("keycloak_amara_password"),
  });
  const back = await fetch(action, {
    method: "POST",
    body: form,
    headers: { cookie: cookies.join("; ") },
    redirect: "manual",
  });
  const callback = back.headers.get("location") ?? "";
  return auth.finishSignIn(callback, saved);
}

async function adminToken(): Promise<string> {
  const response = await fetch(
    "http://localhost:8180/realms/master/protocol/openid-connect/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: "admin",
        password: secret("keycloak_admin_password"),
      }),
    },
  );
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Change how long the realm's access tokens live, so a check can wait for one to expire. */
export async function setTokenSeconds(seconds: number): Promise<void> {
  const response = await fetch("http://localhost:8180/admin/realms/council", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${await adminToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ accessTokenLifespan: seconds }),
  });
  if (!response.ok) throw new Error(`the realm refused the new token lifetime: ${response.status}`);
}

/** Ask the realm's sign-in page for a code with no PKCE challenge. True when it refuses. */
export async function refusesWithoutPkce(): Promise<boolean> {
  const page = new URL(`${REALM_URL}/protocol/openid-connect/auth`);
  page.searchParams.set("client_id", "permit-desk");
  page.searchParams.set("response_type", "code");
  page.searchParams.set("scope", "openid");
  page.searchParams.set("redirect_uri", "http://localhost:3000/staff/callback");
  const response = await fetch(page, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  return location.includes("error=invalid_request");
}

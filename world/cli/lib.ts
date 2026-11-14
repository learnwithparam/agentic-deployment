// biome-ignore-all lint/style/useNamingConvention: env vars and gateway JSON keep their names
// (HDC_SECRETS, max_budget_usd), because compose files and the gateway read them exactly.
// Shared helpers for the world commands and the checks.
// Only Bun built-ins, so `bun run check` works before `bun install`.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
export const SECRETS = join(ROOT, "secrets");
export const URLS = {
  register: "http://localhost:7001",
  gateway: "http://localhost:7002",
  idp: "http://localhost:7003",
  traces: "http://localhost:7004",
  desk: "http://localhost:3000",
  finished: "http://localhost:8080",
  prometheus: "http://localhost:9090",
  alertmanager: "http://localhost:9093",
};

export type CommandResult = { code: number; out: string; err: string };
type CommandOptions = { env?: Record<string, string>; cwd?: string; quiet?: boolean };

/** Run a command and collect what it printed and its exit code. */
export async function runCommand(
  command: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { code, out, err };
}

export const secret = (name: string) => readFileSync(join(SECRETS, name), "utf8").trim();

function makeSecretOnce(name: string, makeValue: () => string) {
  const file = join(SECRETS, name);
  if (!existsSync(file)) writeFileSync(file, `${makeValue()}\n`);
  // Containers run as another user and must read the file.
  chmodSync(file, 0o644);
}

function makePasswords(): string {
  const peopleFile = readFileSync(join(ROOT, "world", "data", "people.json"), "utf8");
  const people = JSON.parse(peopleFile).people as { username: string }[];
  const passwords = people.map((person) => [person.username, randomBytes(6).toString("base64url")]);
  return JSON.stringify(Object.fromEntries(passwords), null, 2);
}

/** Make the world's secrets once. They live in secrets/, which git ignores. */
export function ensureSecrets() {
  mkdirSync(SECRETS, { recursive: true });
  makeSecretOnce("gateway_admin_key", () => `hdc-admin-${randomBytes(20).toString("hex")}`);
  makeSecretOnce("desk_gateway_key", () => `hdc-gw-${randomBytes(18).toString("hex")}`);
  makeSecretOnce("finished_gateway_key", () => `hdc-gw-${randomBytes(18).toString("hex")}`);
  makeSecretOnce("desk_client_secret", () => randomBytes(18).toString("hex"));
  makeSecretOnce("passwords", makePasswords);
  // For the Keycloak step in the go-further part.
  makeSecretOnce("keycloak_amara_password", () => randomBytes(12).toString("base64url"));
  makeSecretOnce("keycloak_admin_password", () => randomBytes(12).toString("base64url"));
}

/** Env every compose command gets, so compose files can find the secrets folder. */
export function composeEnv() {
  const hasAdminKey = existsSync(join(SECRETS, "gateway_admin_key"));
  return {
    HDC_SECRETS: SECRETS,
    HDC_ROOT: ROOT,
    GATEWAY_ADMIN_KEY: hasAdminKey ? secret("gateway_admin_key") : "",
  };
}

export async function healthy(url: string, tries = 1): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // Not answering yet; try again after a short wait.
    }
    if (i < tries - 1) await Bun.sleep(1000);
  }
  return false;
}

export async function worldUp(): Promise<boolean> {
  const services = [URLS.register, URLS.gateway, URLS.idp, URLS.traces];
  const answers = await Promise.all(services.map((base) => healthy(`${base}/health`)));
  return answers.every(Boolean);
}

/** Call the gateway's admin API: GET when there is no body, POST when there is. */
export async function admin<Answer = unknown>(path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${URLS.gateway}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${secret("gateway_admin_key")}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as Answer;
}

async function startContainers(log: (line: string) => void) {
  log(
    "Starting the world: register, gateway, sign-in, trace desk. The first start builds an image.",
  );
  const composeUp = [
    ...["docker", "compose", "-f", "world/compose.yaml", "up"],
    ...["-d", "--build", "--wait", "--wait-timeout", "120"],
  ];
  const result = await runCommand(composeUp, { env: composeEnv() });
  if (result.code !== 0) {
    const printed = (result.err || result.out).trim();
    const lastLines = printed.split("\n").slice(-8).join("\n");
    throw new Error(`docker compose could not start the world:\n${lastLines}`);
  }
}

/** Start the world (build on first run), register the service keys, and wait for every service. */
export async function startWorld(log = console.log): Promise<void> {
  ensureSecrets();
  mkdirSync(join(ROOT, "out"), { recursive: true });
  if (!(await worldUp())) await startContainers(log);
  if (!(await worldUp())) {
    throw new Error("The world started but a service does not answer on ports 7001 to 7004.");
  }
  await admin("/admin/keys", { name: "desk", key: secret("desk_gateway_key"), max_budget_usd: 2 });
  await admin("/admin/keys", {
    name: "finished",
    key: secret("finished_gateway_key"),
    max_budget_usd: 50,
  });
}

/** Put the world back to its first state: every application received, no letters, no spend. */
export async function resetWorld() {
  await fetch(`${URLS.register}/admin/reset`, { method: "POST" });
  await admin("/admin/reset", {});
  await fetch(`${URLS.traces}/api/reset`, { method: "POST" });
}

export async function gatewayProvider(): Promise<string> {
  const response = await fetch(`${URLS.gateway}/health`);
  const health = (await response.json()) as { provider: string };
  return health.provider;
}

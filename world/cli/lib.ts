// Shared helpers for the world commands and the checks. Only Bun built-ins, so `bun run check` works
// before `bun install`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

export type Out = { code: number; out: string; err: string };
export async function sh(cmd: string[], opts: { env?: Record<string, string>; cwd?: string; quiet?: boolean } = {}): Promise<Out> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out, err };
}

export const secret = (name: string) => readFileSync(join(SECRETS, name), "utf8").trim();

/** Make the world's secrets once. They live in secrets/, which git ignores. */
export function ensureSecrets() {
  mkdirSync(SECRETS, { recursive: true });
  const make = (name: string, value: () => string) => {
    const f = join(SECRETS, name);
    if (!existsSync(f)) writeFileSync(f, value() + "\n");
    chmodSync(f, 0o644); // containers run as another user and must read the file
  };
  make("gateway_admin_key", () => `hdc-admin-${randomBytes(20).toString("hex")}`);
  make("desk_gateway_key", () => `hdc-gw-${randomBytes(18).toString("hex")}`);
  make("finished_gateway_key", () => `hdc-gw-${randomBytes(18).toString("hex")}`);
  make("desk_client_secret", () => randomBytes(18).toString("hex"));
  const people = JSON.parse(readFileSync(join(ROOT, "world", "data", "people.json"), "utf8")).people as { username: string }[];
  make("passwords", () => JSON.stringify(Object.fromEntries(people.map((p) => [p.username, randomBytes(6).toString("base64url")])), null, 2));
}

/** Env every compose command gets, so compose files can find the secrets folder. */
export const composeEnv = () => ({ HDC_SECRETS: SECRETS, HDC_ROOT: ROOT, GATEWAY_ADMIN_KEY: existsSync(join(SECRETS, "gateway_admin_key")) ? secret("gateway_admin_key") : "" });

export async function healthy(url: string, tries = 1): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {}
    if (i < tries - 1) await Bun.sleep(1000);
  }
  return false;
}

export async function worldUp(): Promise<boolean> {
  const all = await Promise.all(["register", "gateway", "idp", "traces"].map((s) => healthy(`${URLS[s as keyof typeof URLS]}/health`)));
  return all.every(Boolean);
}

export async function admin(path: string, body?: unknown) {
  const r = await fetch(`${URLS.gateway}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${secret("gateway_admin_key")}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json() as Promise<any>;
}

/** Start the world (build on first run), register the service keys, and wait until every service answers. */
export async function startWorld(log = console.log): Promise<void> {
  ensureSecrets();
  mkdirSync(join(ROOT, "out"), { recursive: true });
  if (!(await worldUp())) {
    log("Starting the world: register, gateway, sign-in, trace desk. The first start builds an image.");
    const r = await sh(["docker", "compose", "-f", "world/compose.yaml", "up", "-d", "--build", "--wait", "--wait-timeout", "120"], { env: composeEnv() });
    if (r.code !== 0) throw new Error(`docker compose could not start the world:\n${(r.err || r.out).trim().split("\n").slice(-8).join("\n")}`);
  }
  if (!(await worldUp())) throw new Error("The world started but a service does not answer on ports 7001 to 7004.");
  await admin("/admin/keys", { name: "desk", key: secret("desk_gateway_key"), max_budget_usd: 2 });
  await admin("/admin/keys", { name: "finished", key: secret("finished_gateway_key"), max_budget_usd: 2 });
}

/** Put the world back to its first state: every application received, no letters, no spend, no spans. */
export async function resetWorld() {
  await fetch(`${URLS.register}/admin/reset`, { method: "POST" });
  await admin("/admin/reset", {});
  await fetch(`${URLS.traces}/api/reset`, { method: "POST" });
}

export async function gatewayProvider(): Promise<string> {
  return ((await (await fetch(`${URLS.gateway}/health`)).json()) as any).provider;
}

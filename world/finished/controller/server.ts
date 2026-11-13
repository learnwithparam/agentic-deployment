// biome-ignore-all lint/style/useNamingConvention: state JSON stays snake_case, like canary_weight
// The release controller: owns the canary. It writes Traefik's weights and the canary's release
// file, and rolls the canary back when Alertmanager calls its webhook. Every change goes into an
// audit log.
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 7010);
const CONTROL = process.env.CONTROL_DIR ?? "/control";
const RELEASES = process.env.RELEASES_DIR ?? join(import.meta.dir, "..", "..", "releases");
const TRAEFIK = join(CONTROL, "traefik", "dynamic.yml");
const CANARY = join(CONTROL, "canary", "release.json");
const STATE = join(CONTROL, "state.json");
const AUDIT = join(CONTROL, "audit.jsonl");
for (const folder of ["traefik", "canary"]) mkdirSync(join(CONTROL, folder), { recursive: true });

type State = { canary_release: string; canary_weight: number; pinned: boolean; since?: string };
type Alert = {
  status: string;
  fingerprint: string;
  startsAt: string;
  labels: Record<string, string>;
};

const FIRST_STATE: State = { canary_release: "v1", canary_weight: 0, pinned: false };

function loadState(): State {
  if (!existsSync(STATE)) return { ...FIRST_STATE };
  return JSON.parse(readFileSync(STATE, "utf8"));
}

function audit(entry: Record<string, unknown>) {
  const line = { at: new Date().toISOString(), ...entry };
  appendFileSync(AUDIT, `${JSON.stringify(line)}\n`);
}

function traefikConfig(canaryWeight: number): string {
  const stableWeight = 100 - canaryWeight;
  const canaryEntry =
    canaryWeight > 0 ? `          - name: canary\n            weight: ${canaryWeight}\n` : "";
  return `http:
  routers:
    desk:
      rule: "PathPrefix(\`/\`)"
      entryPoints: [web]
      service: desk
  services:
    desk:
      weighted:
        services:
          - name: stable
            weight: ${stableWeight}
${canaryEntry}    stable:
      loadBalancer:
        servers: [{ url: "http://desk-stable:3000" }]
    canary:
      loadBalancer:
        servers: [{ url: "http://desk-canary:3000" }]
`;
}

function apply(state: State) {
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  copyFileSync(join(RELEASES, `${state.canary_release}.json`), CANARY);
  // Traefik reads this file and changes the split within a second or two.
  writeFileSync(TRAEFIK, traefikConfig(state.canary_weight));
}

// Write the files on every start, so Traefik and the canary match the saved state.
apply(loadState());

function auditLog() {
  if (!existsSync(AUDIT)) return [];
  const lines = readFileSync(AUDIT, "utf8").trim().split("\n");
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

async function setCanary(request: Request): Promise<Response> {
  const body = (await request.json()) as { release: string; weight: number };
  if (!existsSync(join(RELEASES, `${body.release}.json`))) {
    return Response.json({ error: `no release ${body.release}` }, { status: 404 });
  }
  const state = {
    canary_release: body.release,
    canary_weight: Math.max(0, Math.min(100, body.weight)),
    pinned: false,
    since: new Date().toISOString(),
  };
  apply(state);
  audit({ action: "canary", release: body.release, weight: state.canary_weight });
  return Response.json(state);
}

function reset(): Response {
  writeFileSync(AUDIT, "");
  const state = { ...FIRST_STATE };
  apply(state);
  return Response.json(state);
}

// Alertmanager's webhook. A firing alert about the canary's release sends all traffic to stable.
async function receiveAlerts(request: Request): Promise<Response> {
  const body = (await request.json()) as { alerts?: Alert[] };
  const state = loadState();
  for (const alert of body.alerts ?? []) {
    const aboutCanary = alert.labels.release === state.canary_release;
    if (alert.status !== "firing" || !aboutCanary || state.canary_weight === 0) continue;
    state.canary_weight = 0;
    state.pinned = true;
    apply(state);
    audit({
      action: "rollback",
      release: alert.labels.release,
      alert: alert.labels.alertname,
      fingerprint: alert.fingerprint,
    });
  }
  return Response.json({ status: "ok" });
}

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/health") return Response.json({ status: "ok" });
  if (path === "/state") return Response.json({ ...loadState(), audit: auditLog() });
  if (request.method === "POST" && path === "/canary") return setCanary(request);
  if (request.method === "POST" && path === "/reset") return reset();
  if (request.method === "POST" && path === "/alert") return receiveAlerts(request);
  return Response.json({ error: "not found" }, { status: 404 });
}

Bun.serve({ port: PORT, fetch: answer });
console.log(`release controller listening on ${PORT}`);

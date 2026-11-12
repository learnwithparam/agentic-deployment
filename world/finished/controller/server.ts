// The release controller: owns the canary. It writes Traefik's weights and the canary's release file, and
// rolls the canary back when Alertmanager calls its webhook. Every change goes into an audit log.
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
for (const d of ["traefik", "canary"]) mkdirSync(join(CONTROL, d), { recursive: true });

type State = { canary_release: string; canary_weight: number; pinned: boolean; since?: string };
const load = (): State =>
  existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8"))
    : { canary_release: "v1", canary_weight: 0, pinned: false };
const audit = (e: Record<string, unknown>) =>
  appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");

function apply(s: State) {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  copyFileSync(join(RELEASES, `${s.canary_release}.json`), CANARY);
  const stable = 100 - s.canary_weight;
  // Traefik reads this file and changes the split within a second or two.
  writeFileSync(
    TRAEFIK,
    `http:
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
            weight: ${stable}
${s.canary_weight > 0 ? `          - name: canary\n            weight: ${s.canary_weight}\n` : ""}    stable:
      loadBalancer:
        servers: [{ url: "http://desk-stable:3000" }]
    canary:
      loadBalancer:
        servers: [{ url: "http://desk-canary:3000" }]
`,
  );
}
if (!existsSync(STATE)) apply(load());
else apply(load());

const auditLog = () =>
  existsSync(AUDIT)
    ? readFileSync(AUDIT, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/state") return Response.json({ ...load(), audit: auditLog() });
    if (req.method === "POST" && url.pathname === "/canary") {
      const b = (await req.json()) as { release: string; weight: number };
      if (!existsSync(join(RELEASES, `${b.release}.json`)))
        return Response.json({ error: `no release ${b.release}` }, { status: 404 });
      const s = {
        canary_release: b.release,
        canary_weight: Math.max(0, Math.min(100, b.weight)),
        pinned: false,
        since: new Date().toISOString(),
      };
      apply(s);
      audit({ action: "canary", release: b.release, weight: s.canary_weight });
      return Response.json(s);
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      writeFileSync(AUDIT, "");
      const s = { canary_release: "v1", canary_weight: 0, pinned: false };
      apply(s);
      return Response.json(s);
    }
    // Alertmanager's webhook. A firing alert about the canary's release sends all traffic back to stable.
    if (req.method === "POST" && url.pathname === "/alert") {
      const b = (await req.json()) as {
        alerts?: {
          status: string;
          fingerprint: string;
          startsAt: string;
          labels: Record<string, string>;
        }[];
      };
      const s = load();
      for (const a of b.alerts ?? []) {
        if (a.status !== "firing" || a.labels.release !== s.canary_release || s.canary_weight === 0)
          continue;
        s.canary_weight = 0;
        s.pinned = true;
        apply(s);
        audit({
          action: "rollback",
          release: a.labels.release,
          alert: a.labels.alertname,
          fingerprint: a.fingerprint,
        });
      }
      return Response.json({ status: "ok" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
console.log(`release controller listening on ${PORT}`);

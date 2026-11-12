// The permit register: Harrowby's system of record. Every status and every letter lives here.
// The agent may write invalid_missing_items or valid_awaiting_officer; only an officer's action writes validated.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { applications, checklist, expected, missingItems, feeOwed, type Application } from "./rules";

const PORT = Number(process.env.PORT ?? 7001);
const DIR = process.env.REGISTER_DATA ?? "/data";
mkdirSync(DIR, { recursive: true });
const db = new Database(`${DIR}/register.db`, { create: true });
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL,
  status_by TEXT, release TEXT, agrees INTEGER, idempotency_key TEXT);
CREATE TABLE IF NOT EXISTS letters (id INTEGER PRIMARY KEY AUTOINCREMENT, application_id TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, release TEXT, idempotency_key TEXT UNIQUE, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
  application_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS chaos (k TEXT PRIMARY KEY, v TEXT);`);

const now = () => new Date().toISOString();
const audit = (actor: string, action: string, id: string | null, detail: unknown = {}) =>
  db.run("INSERT INTO audit (at, actor, action, application_id, detail) VALUES (?,?,?,?,?)", [now(), actor, action, id, JSON.stringify(detail)]);

function seed() {
  db.exec("DELETE FROM applications; DELETE FROM letters; DELETE FROM audit; DELETE FROM chaos;");
  const ins = db.prepare("INSERT INTO applications (id, body, status) VALUES (?, ?, 'received')");
  for (const a of applications()) ins.run(a.id, JSON.stringify(a));
  audit("world", "reset", null, { applications: applications().length });
}
if ((db.query("SELECT count(*) AS n FROM applications").get() as any).n === 0) seed();

const row = (id: string) => db.query("SELECT * FROM applications WHERE id = ?").get(id) as any;
const app = (id: string): Application | null => { const r = row(id); return r ? JSON.parse(r.body) : null; };
const chaos = (k: string) => (db.query("SELECT v FROM chaos WHERE k = ?").get(k) as any)?.v as string | undefined;
const json = (b: unknown, status = 200) => Response.json(b, { status });
const PAGE = 3; // checklist items per page

// Counters for Prometheus, by release, whether the decision agreed with the rules.
const decisions = new Map<string, number>();

function publicView(a: Application) {
  // What the agent needs: no email or phone. The resident's contact details stay in the register.
  const { applicant, planted, ...rest } = a;
  return { ...rest, applicant: { name: applicant.name } };
}

function html(rows: any[]) {
  const tr = rows.map((r) => {
    const a = JSON.parse(r.body);
    return `<tr><td>${r.id}</td><td>${a.description}</td><td class="s ${r.status}">${r.status}</td><td>${r.release ?? ""}</td></tr>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>Harrowby permit register</title>
<style>body{font:15px system-ui;margin:24px;background:#f6f5f1;color:#1d1d1b}table{border-collapse:collapse;width:100%;background:#fff}
td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left}.s{font-family:monospace}.invalid_missing_items{color:#a33}
.valid_awaiting_officer{color:#2a6}.validated{color:#25a;font-weight:600}h1{font-size:20px}</style>
<h1>Harrowby District Council: permit register</h1><table><tr><th>Application</th><th>Proposal</th><th>Status</th><th>Release</th></tr>${tr}</table>`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean);
    const actor = req.headers.get("x-actor") ?? "unknown";
    try {
      if (req.method === "GET" && url.pathname === "/health") return json({ status: "ok" });
      if (req.method === "GET" && url.pathname === "/") return new Response(html(db.query("SELECT * FROM applications ORDER BY id").all()), { headers: { "content-type": "text/html" } });
      if (req.method === "GET" && url.pathname === "/applications")
        return json((db.query("SELECT id, status, status_by, release FROM applications ORDER BY id").all()));
      if (p[0] === "applications" && p[1]) {
        const id = p[1];
        const a = app(id);
        if (!a) return json({ error: `no application ${id}` }, 404);
        if (req.method === "GET" && p.length === 2) return json({ ...publicView(a), status: row(id).status });
        if (req.method === "GET" && p[2] === "checklist") {
          const page = Number(url.searchParams.get("page") ?? 1);
          const c = checklist();
          const required = c.types[a.type]?.required ?? [];
          const slice = required.slice((page - 1) * PAGE, page * PAGE);
          const have = new Set(a.attachments.map((x) => x.item));
          const runaway = a.planted === "runaway";
          const more = runaway || page * PAGE < required.length;
          return json({
            application_id: id, page, items: slice.map((i) => ({ item: i, label: c.items[i], present: have.has(i) })),
            more, next_page: more ? page + 1 : null,
            note: runaway ? "The attachment list continues on the next page." : undefined,
          });
        }
        if (req.method === "GET" && p[2] === "fee") {
          const c = checklist();
          return json({ application_id: id, fee_due_gbp: c.types[a.type].fee_gbp, fee_paid_gbp: a.fee_paid_gbp, owed_gbp: feeOwed(a, c) });
        }
        if (req.method === "POST" && p[2] === "decision") {
          const body = (await req.json()) as { status: string; missing_items?: string[] };
          const key = req.headers.get("idempotency-key");
          const release = req.headers.get("x-release") ?? "unknown";
          if (!["invalid_missing_items", "valid_awaiting_officer"].includes(body.status))
            return json({ error: `the agent may not write status "${body.status}"` }, 403);
          const r = row(id);
          if (r.status !== "received") {
            if (key && r.idempotency_key === key) return json({ application_id: id, status: r.status, replayed: true });
            audit(actor, "decision_refused", id, { reason: "already decided", status: body.status });
            return json({ error: `${id} already has status ${r.status}` }, 409);
          }
          const e = expected(a);
          const agrees = e.status === body.status ? 1 : 0;
          db.run("UPDATE applications SET status=?, status_by=?, release=?, agrees=?, idempotency_key=? WHERE id=?", [body.status, actor, release, agrees, key, id]);
          const k = `${release}|${agrees ? "yes" : "no"}`;
          decisions.set(k, (decisions.get(k) ?? 0) + 1);
          audit(actor, "decision", id, { status: body.status, missing_items: body.missing_items ?? [], release, agrees: !!agrees });
          return json({ application_id: id, status: body.status });
        }
        if (req.method === "POST" && p[2] === "letters") {
          const body = (await req.json()) as { kind?: string; body: string };
          const key = req.headers.get("idempotency-key");
          const hold = Number(chaos("hold_letters_ms") ?? 0);
          if (hold > 0) { audit("world", "letter_held", id, { ms: hold }); await Bun.sleep(hold); }
          if (key) {
            const prev = db.query("SELECT id FROM letters WHERE idempotency_key = ?").get(key) as any;
            if (prev) return json({ letter_id: prev.id, replayed: true });
          }
          const kind = body.kind ?? "validation";
          const res = db.run("INSERT INTO letters (application_id, kind, body, release, idempotency_key, at) VALUES (?,?,?,?,?,?)",
            [id, kind, body.body, req.headers.get("x-release"), key, now()]);
          audit(actor, "letter", id, { kind });
          return json({ letter_id: Number(res.lastInsertRowid) });
        }
        if (req.method === "POST" && p[2] === "validate") {
          const body = (await req.json().catch(() => ({}))) as { officer?: string };
          const r = row(id);
          if (r.status !== "valid_awaiting_officer") return json({ error: `${id} is ${r.status}, not valid_awaiting_officer` }, 409);
          db.run("UPDATE applications SET status='validated', status_by=? WHERE id=?", [body.officer ?? actor, id]);
          audit(body.officer ?? actor, "validated", id);
          return json({ application_id: id, status: "validated" });
        }
      }
      if (req.method === "GET" && url.pathname === "/letters") {
        const id = url.searchParams.get("application_id");
        return json(id ? db.query("SELECT * FROM letters WHERE application_id = ? ORDER BY id").all(id) : db.query("SELECT * FROM letters ORDER BY id").all());
      }
      if (req.method === "GET" && url.pathname === "/audit")
        return json(db.query("SELECT * FROM audit ORDER BY id").all().map((r: any) => ({ ...r, detail: JSON.parse(r.detail) })));
      if (req.method === "GET" && url.pathname === "/expected") {
        const id = url.searchParams.get("application_id")!;
        const a = app(id);
        return a ? json({ application_id: id, ...expected(a), missing_items_only: missingItems(a) }) : json({ error: "no such application" }, 404);
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        let out = "# HELP register_decisions_total Decisions the agent wrote, by release and by whether the rules agree.\n# TYPE register_decisions_total counter\n";
        for (const [k, v] of decisions) { const [rel, ag] = k.split("|"); out += `register_decisions_total{release="${rel}",agrees="${ag}"} ${v}\n`; }
        return new Response(out, { headers: { "content-type": "text/plain; version=0.0.4" } });
      }
      if (req.method === "POST" && url.pathname === "/admin/reset") { seed(); decisions.clear(); return json({ status: "reset", applications: applications().length }); }
      if (req.method === "POST" && url.pathname === "/admin/chaos") {
        const body = (await req.json()) as Record<string, string | number | null>;
        for (const [k, v] of Object.entries(body)) v === null ? db.run("DELETE FROM chaos WHERE k=?", [k]) : db.run("INSERT OR REPLACE INTO chaos (k, v) VALUES (?, ?)", [k, String(v)]);
        audit("world", "chaos", null, body);
        return json({ status: "ok" });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },
});
console.log(`register listening on ${PORT}`);

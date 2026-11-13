// biome-ignore-all lint/style/useNamingConvention: JSON fields stay snake_case, like application_id
// The permit register: Harrowby's system of record. Every status and every letter lives here.
// The agent may write invalid_missing_items or valid_awaiting_officer;
// only an officer's action writes validated.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import {
  type Application,
  applications,
  checklist,
  expected,
  feeOwed,
  missingItems,
} from "./rules";

const PORT = Number(process.env.PORT ?? 7001);
const DIR = process.env.REGISTER_DATA ?? "/data";
const ITEMS_PER_PAGE = 3;
const AGENT_STATUSES = ["invalid_missing_items", "valid_awaiting_officer"];

mkdirSync(DIR, { recursive: true });
const db = new Database(`${DIR}/register.db`, { create: true });
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, body TEXT NOT NULL,
  status TEXT NOT NULL, status_by TEXT, release TEXT, agrees INTEGER, idempotency_key TEXT);
CREATE TABLE IF NOT EXISTS letters (id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, release TEXT,
  idempotency_key TEXT UNIQUE, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
  actor TEXT, action TEXT NOT NULL, application_id TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS chaos (k TEXT PRIMARY KEY, v TEXT);`);

type ApplicationRow = {
  id: string;
  body: string;
  status: string;
  status_by: string | null;
  release: string | null;
  agrees: number | null;
  idempotency_key: string | null;
};
type AuditRow = { detail: string };

// Counters for Prometheus, by release, and whether the decision agreed with the rules.
const decisions = new Map<string, number>();

const now = () => new Date().toISOString();
const json = (body: unknown, status = 200) => Response.json(body, { status });

function audit(actor: string, action: string, id: string | null, detail: unknown = {}) {
  db.run("INSERT INTO audit (at, actor, action, application_id, detail) VALUES (?,?,?,?,?)", [
    now(),
    actor,
    action,
    id,
    JSON.stringify(detail),
  ]);
}

function seed() {
  db.exec("DELETE FROM applications; DELETE FROM letters; DELETE FROM audit; DELETE FROM chaos;");
  const insert = db.prepare(
    "INSERT INTO applications (id, body, status) VALUES (?, ?, 'received')",
  );
  for (const application of applications()) {
    insert.run(application.id, JSON.stringify(application));
  }
  audit("world", "reset", null, { applications: applications().length });
}

const firstStart = db.query("SELECT count(*) AS n FROM applications").get() as { n: number };
if (firstStart.n === 0) seed();

function applicationRow(id: string): ApplicationRow {
  return db.query("SELECT * FROM applications WHERE id = ?").get(id) as ApplicationRow;
}

function findApplication(id: string): Application | null {
  const row = applicationRow(id);
  return row ? JSON.parse(row.body) : null;
}

function chaosSetting(name: string): string | undefined {
  const setting = db.query("SELECT v FROM chaos WHERE k = ?").get(name) as { v: string } | null;
  return setting?.v;
}

function publicView(application: Application) {
  // What the agent needs: no email or phone. The resident's contact details stay in the register.
  const { applicant, planted, ...rest } = application;
  return { ...rest, applicant: { name: applicant.name } };
}

const PAGE_STYLE =
  "body{font:15px system-ui;margin:24px;background:#f6f5f1;color:#1d1d1b}" +
  "table{border-collapse:collapse;width:100%;background:#fff}\n" +
  "td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left}" +
  ".s{font-family:monospace}.invalid_missing_items{color:#a33}\n" +
  ".valid_awaiting_officer{color:#2a6}.validated{color:#25a;font-weight:600}h1{font-size:20px}";

function tableRow(row: ApplicationRow): string {
  const application = JSON.parse(row.body) as Application;
  const cells = [
    `<td>${row.id}</td>`,
    `<td>${application.description}</td>`,
    `<td class="s ${row.status}">${row.status}</td>`,
    `<td>${row.release ?? ""}</td>`,
  ];
  return `<tr>${cells.join("")}</tr>`;
}

function registerPage(rows: ApplicationRow[]): string {
  const tableRows = rows.map(tableRow).join("");
  const header = "<tr><th>Application</th><th>Proposal</th><th>Status</th><th>Release</th></tr>";
  return (
    `<!doctype html><meta charset="utf-8"><title>Harrowby permit register</title>\n` +
    `<style>${PAGE_STYLE}</style>\n` +
    `<h1>Harrowby District Council: permit register</h1><table>${header}${tableRows}</table>`
  );
}

function checklistPage(id: string, application: Application, url: URL): Response {
  const page = Number(url.searchParams.get("page") ?? 1);
  const rules = checklist();
  const required = rules.types[application.type]?.required ?? [];
  const onThisPage = required.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
  const attached = new Set(application.attachments.map((attachment) => attachment.item));
  // A planted "runaway" application never runs out of pages, to test the agent's step limit.
  const runaway = application.planted === "runaway";
  const more = runaway || page * ITEMS_PER_PAGE < required.length;
  return json({
    application_id: id,
    page,
    items: onThisPage.map((item) => ({
      item,
      label: rules.items[item],
      present: attached.has(item),
    })),
    more,
    next_page: more ? page + 1 : null,
    note: runaway ? "The attachment list continues on the next page." : undefined,
  });
}

function feeAnswer(id: string, application: Application): Response {
  const rules = checklist();
  return json({
    application_id: id,
    fee_due_gbp: rules.types[application.type].fee_gbp,
    fee_paid_gbp: application.fee_paid_gbp,
    owed_gbp: feeOwed(application, rules),
  });
}

function sameItems(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((item) => second.includes(item));
}

type Decision = { status: string; missing_items?: string[] };

function agreesWithRules(application: Application, decision: Decision): number {
  const truth = expected(application);
  const sameStatus = truth.status === decision.status;
  return sameStatus && sameItems(truth.missing, decision.missing_items ?? []) ? 1 : 0;
}

async function writeDecision(request: Request, id: string, application: Application) {
  const decision = (await request.json()) as Decision;
  const key = request.headers.get("idempotency-key");
  const release = request.headers.get("x-release") ?? "unknown";
  const actor = request.headers.get("x-actor") ?? "unknown";
  if (!AGENT_STATUSES.includes(decision.status)) {
    return json({ error: `the agent may not write status "${decision.status}"` }, 403);
  }
  const row = applicationRow(id);
  if (row.status !== "received") {
    if (key && row.idempotency_key === key) {
      return json({ application_id: id, status: row.status, replayed: true });
    }
    audit(actor, "decision_refused", id, { reason: "already decided", status: decision.status });
    return json({ error: `${id} already has status ${row.status}` }, 409);
  }
  const agrees = agreesWithRules(application, decision);
  db.run(
    "UPDATE applications SET status=?, status_by=?, release=?, agrees=?, idempotency_key=? " +
      "WHERE id=?",
    [decision.status, actor, release, agrees, key, id],
  );
  const counterName = `${release}|${agrees ? "yes" : "no"}`;
  decisions.set(counterName, (decisions.get(counterName) ?? 0) + 1);
  audit(actor, "decision", id, {
    status: decision.status,
    missing_items: decision.missing_items ?? [],
    release,
    agrees: !!agrees,
  });
  return json({ application_id: id, status: decision.status });
}

async function writeLetter(request: Request, id: string) {
  const letter = (await request.json()) as { kind?: string; body: string };
  const key = request.headers.get("idempotency-key");
  const actor = request.headers.get("x-actor") ?? "unknown";
  // Chaos can hold letters back, so learners see a slow system of record.
  const holdMilliseconds = Number(chaosSetting("hold_letters_ms") ?? 0);
  if (holdMilliseconds > 0) {
    audit("world", "letter_held", id, { ms: holdMilliseconds });
    await Bun.sleep(holdMilliseconds);
  }
  if (key) {
    const earlier = db.query("SELECT id FROM letters WHERE idempotency_key = ?").get(key) as {
      id: number;
    } | null;
    if (earlier) return json({ letter_id: earlier.id, replayed: true });
  }
  const kind = letter.kind ?? "validation";
  const inserted = db.run(
    "INSERT INTO letters (application_id, kind, body, release, idempotency_key, at) " +
      "VALUES (?,?,?,?,?,?)",
    [id, kind, letter.body, request.headers.get("x-release"), key, now()],
  );
  audit(actor, "letter", id, { kind });
  return json({ letter_id: Number(inserted.lastInsertRowid) });
}

async function validateByOfficer(request: Request, id: string) {
  const body = (await request.json().catch(() => ({}))) as { officer?: string };
  const actor = request.headers.get("x-actor") ?? "unknown";
  const row = applicationRow(id);
  if (row.status !== "valid_awaiting_officer") {
    return json({ error: `${id} is ${row.status}, not valid_awaiting_officer` }, 409);
  }
  const officer = body.officer ?? actor;
  db.run("UPDATE applications SET status='validated', status_by=? WHERE id=?", [officer, id]);
  audit(officer, "validated", id);
  return json({ application_id: id, status: "validated" });
}

/** Routes under /applications/<id>. Returns undefined when none matches. */
async function applicationRoute(request: Request, url: URL, parts: string[]) {
  const id = parts[1];
  const application = findApplication(id);
  if (!application) return json({ error: `no application ${id}` }, 404);
  const route = `${request.method} ${parts[2] ?? ""}`;
  if (route === "GET " && parts.length === 2) {
    return json({ ...publicView(application), status: applicationRow(id).status });
  }
  if (route === "GET checklist") return checklistPage(id, application, url);
  if (route === "GET fee") return feeAnswer(id, application);
  if (route === "POST decision") return writeDecision(request, id, application);
  if (route === "POST letters") return writeLetter(request, id);
  if (route === "POST validate") return validateByOfficer(request, id);
  return undefined;
}

function listLetters(url: URL): Response {
  const id = url.searchParams.get("application_id");
  if (id) {
    return json(db.query("SELECT * FROM letters WHERE application_id = ? ORDER BY id").all(id));
  }
  return json(db.query("SELECT * FROM letters ORDER BY id").all());
}

function auditLog(): Response {
  const rows = db.query("SELECT * FROM audit ORDER BY id").all() as AuditRow[];
  return json(rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) })));
}

function expectedAnswer(url: URL): Response {
  const id = url.searchParams.get("application_id") ?? "";
  const application = findApplication(id);
  if (!application) return json({ error: "no such application" }, 404);
  const truth = expected(application);
  return json({ application_id: id, ...truth, missing_items_only: missingItems(application) });
}

function metrics(): Response {
  let text =
    "# HELP register_decisions_total Decisions the agent wrote, by release and by whether " +
    "the rules agree.\n# TYPE register_decisions_total counter\n";
  for (const [counterName, count] of decisions) {
    const [release, agrees] = counterName.split("|");
    text += `register_decisions_total{release="${release}",agrees="${agrees}"} ${count}\n`;
  }
  return new Response(text, { headers: { "content-type": "text/plain; version=0.0.4" } });
}

function resetRegister(): Response {
  seed();
  decisions.clear();
  return json({ status: "reset", applications: applications().length });
}

async function reopen(request: Request): Promise<Response> {
  // Put applications back to "received" for more traffic, keeping the decision counts.
  const body = (await request.json()) as { ids: string[] };
  for (const id of body.ids) {
    db.run(
      "UPDATE applications SET status='received', status_by=NULL, release=NULL, agrees=NULL, " +
        "idempotency_key=NULL WHERE id=?",
      [id],
    );
    db.run("DELETE FROM letters WHERE application_id=?", [id]);
  }
  audit("world", "reopen", null, { ids: body.ids });
  return json({ status: "reopened", ids: body.ids });
}

async function setChaos(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, string | number | null>;
  for (const [name, value] of Object.entries(body)) {
    if (value === null) db.run("DELETE FROM chaos WHERE k=?", [name]);
    else db.run("INSERT OR REPLACE INTO chaos (k, v) VALUES (?, ?)", [name, String(value)]);
  }
  audit("world", "chaos", null, body);
  return json({ status: "ok" });
}

function registerOverview(): Response {
  const rows = db.query("SELECT * FROM applications ORDER BY id").all() as ApplicationRow[];
  return new Response(registerPage(rows), { headers: { "content-type": "text/html" } });
}

function applicationList(): Response {
  const query = "SELECT id, status, status_by, release FROM applications ORDER BY id";
  return json(db.query(query).all());
}

const SIMPLE_ROUTES: Record<string, (request: Request, url: URL) => Response | Promise<Response>> =
  {
    "GET /health": () => json({ status: "ok" }),
    "GET /": registerOverview,
    "GET /applications": applicationList,
    "GET /letters": (_request, url) => listLetters(url),
    "GET /audit": auditLog,
    "GET /expected": (_request, url) => expectedAnswer(url),
    "GET /metrics": metrics,
    "POST /admin/reset": resetRegister,
    "POST /admin/reopen": reopen,
    "POST /admin/chaos": setChaos,
  };

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const simpleRoute = SIMPLE_ROUTES[`${request.method} ${url.pathname}`];
  if (simpleRoute) return simpleRoute(request, url);
  if (parts[0] === "applications" && parts[1]) {
    const response = await applicationRoute(request, url, parts);
    if (response) return response;
  }
  return json({ error: "not found" }, 404);
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    try {
      return await answer(request);
    } catch (error) {
      return json({ error: (error as Error).message }, 500);
    }
  },
});
console.log(`register listening on ${PORT}`);

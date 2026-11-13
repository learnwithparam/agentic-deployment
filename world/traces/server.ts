// biome-ignore-all lint/style/useNamingConvention: span JSON stays snake_case, like trace_id
// The trace desk: takes OpenTelemetry spans over OTLP/HTTP (JSON), writes each one as a line of
// spans.jsonl, and shows them as a waterfall. The checks read spans.jsonl, never a vendor API, so
// you can point your exporter at Langfuse, Phoenix or a real OpenTelemetry Collector instead and
// the course still works.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 7004);
const DIR = process.env.TRACES_DATA ?? "/data";
mkdirSync(DIR, { recursive: true });
const FILE = `${DIR}/spans.jsonl`;
if (!existsSync(FILE)) writeFileSync(FILE, "");

type Span = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  service: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  status: string;
  attributes: Record<string, unknown>;
};

// The shapes OTLP/JSON uses. Each attribute value holds exactly one of these fields.
type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: string | number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpValue[] };
};
type OtlpAttribute = { key: string; value?: OtlpValue | null };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  status?: { code?: number | string };
  attributes?: OtlpAttribute[];
};
type OtlpExport = {
  resourceSpans?: {
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: { spans?: OtlpSpan[] }[];
  }[];
};

function plainValue(value: OtlpValue | null | undefined): unknown {
  if (value == null) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(plainValue);
  return JSON.stringify(value);
}

function plainAttributes(attributes: OtlpAttribute[] = []): Record<string, unknown> {
  const pairs = attributes.map((attribute) => [attribute.key, plainValue(attribute.value)]);
  return Object.fromEntries(pairs);
}

const milliseconds = (nanoseconds: string | number) => Number(BigInt(nanoseconds) / 1_000_000n);

// OTLP/JSON should send ids as hex, but some exporters send base64.
function hexId(id: string): string {
  if (/^[0-9a-f]+$/i.test(id)) return id.toLowerCase();
  return Buffer.from(id, "base64").toString("hex");
}

function readSpans(): Span[] {
  const lines = readFileSync(FILE, "utf8").split("\n");
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

function traceSummary(traceId: string, spans: Span[]) {
  const root = spans.find((span) => !span.parent_span_id) ?? spans[0];
  const attributes = root.attributes;
  return {
    trace_id: traceId,
    name: root.name,
    service: root.service,
    start_ms: root.start_ms,
    duration_ms: root.duration_ms,
    spans: spans.length,
    run_id: attributes["run.id"] ?? null,
    application_id: attributes["application.id"] ?? null,
    release: attributes["release.id"] ?? attributes["service.version"] ?? null,
    cost_usd: attributes["app.cost_usd"] ?? null,
    status: attributes["run.status"] ?? root.status,
  };
}

function traces() {
  const spansByTrace = new Map<string, Span[]>();
  for (const span of readSpans()) {
    spansByTrace.set(span.trace_id, [...(spansByTrace.get(span.trace_id) ?? []), span]);
  }
  const summaries = [...spansByTrace.entries()].map(([traceId, spans]) =>
    traceSummary(traceId, spans),
  );
  return summaries.sort((first, second) => second.start_ms - first.start_ms);
}

function toSpan(otlpSpan: OtlpSpan, resource: Record<string, unknown>): Span {
  const start = milliseconds(otlpSpan.startTimeUnixNano);
  const end = milliseconds(otlpSpan.endTimeUnixNano);
  const statusCode = otlpSpan.status?.code;
  const failed = statusCode === 2 || statusCode === "STATUS_CODE_ERROR";
  return {
    trace_id: hexId(otlpSpan.traceId),
    span_id: hexId(otlpSpan.spanId),
    parent_span_id: otlpSpan.parentSpanId ? hexId(otlpSpan.parentSpanId) : null,
    name: otlpSpan.name,
    service: String(resource["service.name"] ?? "unknown"),
    start_ms: start,
    end_ms: end,
    duration_ms: end - start,
    status: failed ? "error" : "ok",
    attributes: { ...resource, ...plainAttributes(otlpSpan.attributes) },
  };
}

async function receiveSpans(request: Request): Promise<Response> {
  if (!(request.headers.get("content-type") ?? "").includes("json")) {
    const error =
      "Send OTLP as JSON (content-type application/json). " +
      "The protobuf exporter is not supported here.";
    return Response.json({ error }, { status: 415 });
  }
  const body = (await request.json()) as OtlpExport;
  let accepted = 0;
  for (const resourceSpans of body.resourceSpans ?? []) {
    const resource = plainAttributes(resourceSpans.resource?.attributes);
    const spans = (resourceSpans.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []);
    for (const otlpSpan of spans) {
      appendFileSync(FILE, `${JSON.stringify(toSpan(otlpSpan, resource))}\n`);
      accepted++;
    }
  }
  return Response.json({ partialSuccess: {}, accepted });
}

const STYLE = `
:root{--bg:#14161a;--fg:#e8e6e1;--mut:#9aa0a6;--bar:#5fb3a1;--tool:#d9a441;--line:#2a2e35}
body{margin:0;font:14px system-ui;background:var(--bg);color:var(--fg)}
header{padding:14px 20px;border-bottom:1px solid var(--line)}h1{font-size:17px;margin:0}
main{display:grid;grid-template-columns:minmax(260px,380px) 1fr;min-height:calc(100vh - 50px)}
#list{border-right:1px solid var(--line);overflow:auto}
.t{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}
.t:hover,.t.on{background:#1f232a}
.m{color:var(--mut);font-size:12px}.c{float:right;font-family:monospace}
#w{padding:16px 20px;overflow:auto}
.row{display:grid;grid-template-columns:260px 1fr 90px;gap:8px;align-items:center;margin:3px 0}
.n{font-family:monospace;font-size:12px;overflow-wrap:anywhere}
.track{position:relative;height:14px;background:#1b1e24;border-radius:3px}
.b{position:absolute;height:14px;border-radius:3px;background:var(--bar)}
.b.tool{background:var(--tool)}
.d{font-family:monospace;font-size:12px;color:var(--mut);text-align:right}
pre{background:#1b1e24;padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap}
@media(max-width:700px){main{grid-template-columns:1fr}.row{grid-template-columns:120px 1fr 60px}}`;

// The page's script runs in the browser: a list of traces on the left, a waterfall on the right.
const SCRIPT = `
function formatCost(cost) {
  if (cost == null) return 'cost unknown';
  return '$' + Number(cost).toFixed(4);
}

async function getJson(path) {
  const response = await fetch(path);
  return response.json();
}

function traceEntry(trace) {
  const entry = document.createElement('div');
  entry.className = 't';
  const details = [trace.name, trace.release || trace.service, trace.spans + ' spans',
    trace.duration_ms + ' ms'];
  entry.innerHTML = '<span class="c">' + formatCost(trace.cost_usd) + '</span>' +
    '<b>' + (trace.application_id || trace.name) + '</b>' +
    '<div class="m">' + details.join(' &middot; ') + '</div>';
  entry.onclick = () => {
    const entries = document.querySelectorAll('.t');
    entries.forEach((other) => other.classList.remove('on'));
    entry.classList.add('on');
    showTrace(trace.trace_id);
  };
  return entry;
}

async function listTraces() {
  const traces = await getJson('/api/traces');
  const list = document.getElementById('list');
  if (!traces.length) {
    list.innerHTML = '<p class="m" style="padding:16px">No traces yet. Run an application.</p>';
  }
  traces.forEach((trace, index) => {
    const entry = traceEntry(trace);
    list.appendChild(entry);
    if (index === 0 && !location.hash) entry.click();
  });
}

function childrenByParent(spans) {
  const children = {};
  const spanIds = new Set(spans.map((span) => span.span_id));
  for (const span of spans) {
    // A span whose parent never arrived is drawn at the top, beside the root.
    const parentKnown = span.parent_span_id && spanIds.has(span.parent_span_id);
    const parent = parentKnown ? span.parent_span_id : 'root';
    children[parent] = children[parent] || [];
    children[parent].push(span);
  }
  return children;
}

function spansInOrder(spans) {
  const children = childrenByParent(spans);
  const ordered = [];
  const visit = (parentId, depth) => {
    const kids = (children[parentId] || []).sort((first, second) =>
      first.start_ms - second.start_ms);
    for (const span of kids) {
      ordered.push([span, depth]);
      visit(span.span_id, depth + 1);
    }
  };
  visit('root', 0);
  return ordered;
}

function waterfallRow(span, depth, firstStart, totalLength) {
  const left = (span.start_ms - firstStart) / totalLength * 100;
  const width = Math.max(.6, span.duration_ms / totalLength * 100);
  const barKind = span.name.startsWith('execute_tool') ? 'tool' : '';
  return '<div class="row">' +
    '<div class="n" style="padding-left:' + depth * 14 + 'px">' + span.name + '</div>' +
    '<div class="track"><div class="b ' + barKind + '" style="left:' + left + '%;width:' +
    width + '%"></div></div>' +
    '<div class="d">' + span.duration_ms + ' ms</div></div>';
}

async function showTrace(traceId) {
  const spans = await getJson('/api/spans?trace_id=' + traceId);
  const firstStart = Math.min(...spans.map((span) => span.start_ms));
  const lastEnd = Math.max(...spans.map((span) => span.end_ms));
  const totalLength = Math.max(1, lastEnd - firstStart);
  const ordered = spansInOrder(spans);
  const root = ordered[0]?.[0];
  const title = root?.attributes['application.id'] || root?.name;
  const cost = formatCost(root?.attributes['app.cost_usd']);
  let page = '<h2 style="font-size:15px">' + title + ' <span class="m">' + cost + '</span></h2>';
  for (const [span, depth] of ordered) {
    page += waterfallRow(span, depth, firstStart, totalLength);
  }
  page += '<pre>' + JSON.stringify(root?.attributes, null, 2) + '</pre>';
  document.getElementById('w').innerHTML = page;
}

listTraces();
`;

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Harrowby trace desk</title>
<style>${STYLE}</style>
<header><h1>Harrowby trace desk</h1></header>
<main><div id="list"></div>
<div id="w"><p class="m">Pick a trace from the list to see its steps.</p></div></main>
<script>${SCRIPT}</script>`;

function spansAnswer(url: URL): Response {
  const traceId = url.searchParams.get("trace_id");
  const spans = readSpans();
  if (!traceId) return Response.json(spans);
  return Response.json(spans.filter((span) => span.trace_id === traceId));
}

function resetSpans(): Response {
  writeFileSync(FILE, "");
  return Response.json({ status: "reset" });
}

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/health") return Response.json({ status: "ok" });
  if (path === "/v1/traces" && request.method === "POST") return receiveSpans(request);
  if (path === "/api/traces") return Response.json(traces());
  if (path === "/api/spans") return spansAnswer(url);
  if (path === "/api/reset" && request.method === "POST") return resetSpans();
  if (path === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
  return Response.json({ error: "not found" }, { status: 404 });
}

Bun.serve({ port: PORT, fetch: answer });
console.log(`trace desk listening on ${PORT}`);

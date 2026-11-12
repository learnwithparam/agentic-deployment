// The trace desk: takes OpenTelemetry spans over OTLP/HTTP (JSON), writes each one as a line of spans.jsonl,
// and shows them as a waterfall. The checks read spans.jsonl, never a vendor API, so you can point your
// exporter at Langfuse, Phoenix or a real OpenTelemetry Collector instead and the course still works.
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

const val = (v: any): unknown =>
  v == null
    ? null
    : "stringValue" in v
      ? v.stringValue
      : "intValue" in v
        ? Number(v.intValue)
        : "doubleValue" in v
          ? Number(v.doubleValue)
          : "boolValue" in v
            ? v.boolValue
            : "arrayValue" in v
              ? (v.arrayValue.values ?? []).map(val)
              : JSON.stringify(v);
const attrs = (a: any[] = []) => Object.fromEntries(a.map((x) => [x.key, val(x.value)]));
const ms = (n: string | number) => Number(BigInt(n) / 1_000_000n);
const hex = (s: string) =>
  /^[0-9a-f]+$/i.test(s) ? s.toLowerCase() : Buffer.from(s, "base64").toString("hex");

function read(): Span[] {
  return readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function traces() {
  const by = new Map<string, Span[]>();
  for (const s of read()) by.set(s.trace_id, [...(by.get(s.trace_id) ?? []), s]);
  return [...by.entries()]
    .map(([id, spans]) => {
      const root = spans.find((s) => !s.parent_span_id) ?? spans[0];
      return {
        trace_id: id,
        name: root.name,
        service: root.service,
        start_ms: root.start_ms,
        duration_ms: root.duration_ms,
        spans: spans.length,
        run_id: root.attributes["run.id"] ?? null,
        application_id: root.attributes["application.id"] ?? null,
        release: root.attributes["release.id"] ?? root.attributes["service.version"] ?? null,
        cost_usd: root.attributes["app.cost_usd"] ?? null,
        status: root.attributes["run.status"] ?? root.status,
      };
    })
    .sort((a, b) => b.start_ms - a.start_ms);
}

const UI = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Harrowby trace desk</title>
<style>:root{--bg:#14161a;--fg:#e8e6e1;--mut:#9aa0a6;--bar:#5fb3a1;--tool:#d9a441;--line:#2a2e35}body{margin:0;font:14px system-ui;background:var(--bg);color:var(--fg)}
header{padding:14px 20px;border-bottom:1px solid var(--line)}h1{font-size:17px;margin:0}main{display:grid;grid-template-columns:minmax(260px,380px) 1fr;min-height:calc(100vh - 50px)}
#list{border-right:1px solid var(--line);overflow:auto}.t{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}.t:hover,.t.on{background:#1f232a}
.m{color:var(--mut);font-size:12px}.c{float:right;font-family:monospace}#w{padding:16px 20px;overflow:auto}.row{display:grid;grid-template-columns:260px 1fr 90px;gap:8px;align-items:center;margin:3px 0}
.n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;font-size:12px}.track{position:relative;height:14px;background:#1b1e24;border-radius:3px}
.b{position:absolute;height:14px;border-radius:3px;background:var(--bar)}.b.tool{background:var(--tool)}.d{font-family:monospace;font-size:12px;color:var(--mut);text-align:right}
pre{background:#1b1e24;padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap}@media(max-width:700px){main{grid-template-columns:1fr}.row{grid-template-columns:120px 1fr 60px}}</style>
<header><h1>Harrowby trace desk</h1></header><main><div id="list"></div><div id="w"><p class="m">Pick a trace.</p></div></main>
<script>
const fmt=c=>c==null?'cost unknown':'$'+Number(c).toFixed(4);
async function list(){const ts=await (await fetch('/api/traces')).json();const L=document.getElementById('list');
L.innerHTML=ts.length?'':'<p class="m" style="padding:16px">No traces yet. Run an application.</p>';
ts.forEach((t,i)=>{const d=document.createElement('div');d.className='t';d.innerHTML='<span class="c">'+fmt(t.cost_usd)+'</span><b>'+(t.application_id||t.name)+'</b><div class="m">'+t.name+' &middot; '+(t.release||t.service)+' &middot; '+t.spans+' spans &middot; '+t.duration_ms+' ms</div>';
d.onclick=()=>{document.querySelectorAll('.t').forEach(x=>x.classList.remove('on'));d.classList.add('on');show(t.trace_id)};L.appendChild(d);if(i===0&&!location.hash)d.click();});}
async function show(id){const ss=await (await fetch('/api/spans?trace_id='+id)).json();const t0=Math.min(...ss.map(s=>s.start_ms)),t1=Math.max(...ss.map(s=>s.end_ms)),span=Math.max(1,t1-t0);
const kids={};ss.forEach(s=>(kids[s.parent_span_id||'root']=kids[s.parent_span_id||'root']||[]).push(s));const out=[];const walk=(p,dep)=>(kids[p]||[]).sort((a,b)=>a.start_ms-b.start_ms).forEach(s=>{out.push([s,dep]);walk(s.span_id,dep+1)});
const ids=new Set(ss.map(s=>s.span_id));ss.filter(s=>s.parent_span_id&&!ids.has(s.parent_span_id)).forEach(s=>(kids.root=kids.root||[]).push(s));walk('root',0);
const root=out[0]?.[0];let h='<h2 style="font-size:15px">'+(root?.attributes['application.id']||root?.name)+' <span class="m">'+fmt(root?.attributes['app.cost_usd'])+'</span></h2>';
out.forEach(([s,dep])=>{const l=(s.start_ms-t0)/span*100,w=Math.max(.6,s.duration_ms/span*100);h+='<div class="row"><div class="n" style="padding-left:'+dep*14+'px">'+s.name+'</div><div class="track"><div class="b '+(s.name.startsWith('execute_tool')?'tool':'')+'" style="left:'+l+'%;width:'+w+'%"></div></div><div class="d">'+s.duration_ms+' ms</div></div>'});
h+='<pre>'+JSON.stringify(root?.attributes,null,2)+'</pre>';document.getElementById('w').innerHTML=h;}
list();
</script>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/v1/traces" && req.method === "POST") {
      if (!(req.headers.get("content-type") ?? "").includes("json"))
        return Response.json(
          {
            error:
              "Send OTLP as JSON (content-type application/json). The protobuf exporter is not supported here.",
          },
          { status: 415 },
        );
      const body = (await req.json()) as any;
      let n = 0;
      for (const rs of body.resourceSpans ?? []) {
        const res = attrs(rs.resource?.attributes);
        for (const ss of rs.scopeSpans ?? [])
          for (const s of ss.spans ?? []) {
            const start = ms(s.startTimeUnixNano),
              end = ms(s.endTimeUnixNano);
            const span: Span = {
              trace_id: hex(s.traceId),
              span_id: hex(s.spanId),
              parent_span_id: s.parentSpanId ? hex(s.parentSpanId) : null,
              name: s.name,
              service: String(res["service.name"] ?? "unknown"),
              start_ms: start,
              end_ms: end,
              duration_ms: end - start,
              status:
                s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR" ? "error" : "ok",
              attributes: { ...res, ...attrs(s.attributes) },
            };
            appendFileSync(FILE, JSON.stringify(span) + "\n");
            n++;
          }
      }
      return Response.json({ partialSuccess: {}, accepted: n });
    }
    if (url.pathname === "/api/traces") return Response.json(traces());
    if (url.pathname === "/api/spans") {
      const t = url.searchParams.get("trace_id");
      return Response.json(t ? read().filter((s) => s.trace_id === t) : read());
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      writeFileSync(FILE, "");
      return Response.json({ status: "reset" });
    }
    if (url.pathname === "/") return new Response(UI, { headers: { "content-type": "text/html" } });
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
console.log(`trace desk listening on ${PORT}`);

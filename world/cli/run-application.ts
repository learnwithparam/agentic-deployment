// bun run run-application HDC-2026-0142           send one application to the finished desk (:8080)
// bun run run-application HDC-2026-0142 --desk    send it to your desk (:3000)
import { healthy, URLS } from "./lib";

const id = process.argv[2];
const base = process.argv.includes("--desk") ? URLS.desk : URLS.finished;
if (!id || !/^HDC-\d{4}-\d{4}$/.test(id)) {
  console.log("Name an application, for example: bun run run-application HDC-2026-0142");
  process.exit(1);
}
if (!(await healthy(`${base}/healthz`))) {
  console.log(
    `Nothing answers on ${base}. Start it first: ${base === URLS.desk ? "bun run up <step-name>" : "bun run up finished"}`,
  );
  process.exit(2);
}
const r = await fetch(`${base}/v1/runs`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-resident-id": `cli-${Date.now()}` },
  body: JSON.stringify({ application_id: id }),
});
if (!(r.headers.get("content-type") ?? "").includes("event-stream")) {
  console.log(`The desk answered ${r.status} without a stream:\n${await r.text()}`);
  process.exit(1);
}
const reader = r.body!.getReader();
const dec = new TextDecoder();
let buf = "";
let text = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const ev = raw.match(/^event: ?(.*)$/m)?.[1];
    const data = JSON.parse(raw.match(/^data: ?(.*)$/m)?.[1] ?? "{}");
    if (ev === "tool") console.log(`  tool   ${data.name} (${data.status})`);
    if (ev === "token") text += data.text;
    if (ev === "error") console.log(`  error  ${data.code}: ${data.message}`);
    if (ev === "done") {
      if (text) console.log(`  answer ${text.trim()}`);
      console.log(
        `Run ${data.run_id} ended: ${data.status}, cost ${data.cost_usd === null ? "unknown" : "$" + Number(data.cost_usd).toFixed(4)}`,
      );
    }
  }
}

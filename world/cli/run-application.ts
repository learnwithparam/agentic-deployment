// biome-ignore-all lint/style/useNamingConvention: the desk's events use snake_case, like run_id
// bun run run-application HDC-2026-0142           send one application to the finished desk (:8080)
// bun run run-application HDC-2026-0142 --desk    send it to your desk (:3000)
import { healthy, URLS } from "./lib";

type DeskEvent = {
  name?: string;
  status?: string;
  text?: string;
  code?: string;
  message?: string;
  run_id?: string;
  cost_usd?: number | null;
};

const applicationId = process.argv[2];
const base = process.argv.includes("--desk") ? URLS.desk : URLS.finished;
if (!applicationId || !/^HDC-\d{4}-\d{4}$/.test(applicationId)) {
  console.log("Name an application, for example: bun run run-application HDC-2026-0142");
  process.exit(1);
}
if (!(await healthy(`${base}/healthz`))) {
  const startCommand = base === URLS.desk ? "bun run up <step-name>" : "bun run up finished";
  console.log(`Nothing answers on ${base}. Start it first: ${startCommand}`);
  process.exit(2);
}
const response = await fetch(`${base}/v1/runs`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-resident-id": `cli-${Date.now()}` },
  body: JSON.stringify({ application_id: applicationId }),
});
if (!(response.headers.get("content-type") ?? "").includes("event-stream")) {
  console.log(`The desk answered ${response.status} without a stream:\n${await response.text()}`);
  process.exit(1);
}

let answerText = "";

function costText(cost: number | null | undefined): string {
  return cost === null ? "unknown" : `$${Number(cost).toFixed(4)}`;
}

function showEvent(eventName: string | undefined, data: DeskEvent) {
  if (eventName === "tool") console.log(`  tool   ${data.name} (${data.status})`);
  if (eventName === "token") answerText += data.text;
  if (eventName === "error") console.log(`  error  ${data.code}: ${data.message}`);
  if (eventName === "done") {
    if (answerText) console.log(`  answer ${answerText.trim()}`);
    console.log(`Run ${data.run_id} ended: ${data.status}, cost ${costText(data.cost_usd)}`);
  }
}

/** One server-sent event: an "event:" line and a "data:" line, ended by a blank line. */
function showRawEvent(rawEvent: string) {
  const eventName = rawEvent.match(/^event: ?(.*)$/m)?.[1];
  const data = JSON.parse(rawEvent.match(/^data: ?(.*)$/m)?.[1] ?? "{}") as DeskEvent;
  showEvent(eventName, data);
}

if (response.body) {
  const decoder = new TextDecoder();
  let unread = "";
  for await (const chunk of response.body) {
    unread += decoder.decode(chunk, { stream: true });
    let end = unread.indexOf("\n\n");
    while (end >= 0) {
      showRawEvent(unread.slice(0, end));
      unread = unread.slice(end + 2);
      end = unread.indexOf("\n\n");
    }
  }
}

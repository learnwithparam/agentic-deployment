// Call the desk's run endpoint and read the Server-Sent Events it streams, with the time each one arrived.
import { URLS } from "../../world/cli/lib";

export type SseEvent = { event: string; data: any; atMs: number };
export type RunResult = { status: number; contentType: string; events: SseEvent[]; firstMs: number | null; body?: string };

export async function postRun(applicationId: string, base = URLS.desk, headers: Record<string, string> = {}): Promise<RunResult> {
  const t0 = performance.now();
  const r = await fetch(`${base}/v1/runs`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ application_id: applicationId }), signal: AbortSignal.timeout(60_000),
  });
  const contentType = r.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !r.body) return { status: r.status, contentType, events: [], firstMs: null, body: await r.text() };
  const events: SseEvent[] = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const event = raw.match(/^event: ?(.*)$/m)?.[1] ?? "message";
      const dataLine = raw.match(/^data: ?(.*)$/m)?.[1] ?? "";
      let data: any = dataLine;
      try { data = JSON.parse(dataLine); } catch {}
      events.push({ event, data, atMs: performance.now() - t0 });
    }
  }
  return { status: r.status, contentType, events, firstMs: events[0]?.atMs ?? null };
}

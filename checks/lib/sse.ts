// biome-ignore-all lint/style/useNamingConvention: JSON fields stay snake_case, like application_id
// Call the desk's run endpoint and read the Server-Sent Events it streams, with the time each one
// arrived.
import { URLS } from "../../world/cli/lib";

/** An event's data is parsed JSON, or the raw text when it is not JSON. */
export type SseEvent = { event: string; data: unknown; atMs: number };
export type RunResult = {
  status: number;
  contentType: string;
  events: SseEvent[];
  firstMs: number | null;
  body?: string;
};

// One event is a block of lines: "event: name" and "data: text". A missing name means "message".
function parseEvent(block: string, atMs: number): SseEvent {
  const event = block.match(/^event: ?(.*)$/m)?.[1] ?? "message";
  const dataLine = block.match(/^data: ?(.*)$/m)?.[1] ?? "";
  let data: unknown = dataLine;
  try {
    data = JSON.parse(dataLine);
  } catch {
    // The data is plain text, so it stays as it came.
  }
  return { event, data, atMs };
}

async function readEvents(
  stream: ReadableStream<Uint8Array>,
  startedAt: number,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // A blank line ends an event; keep any unfinished event in the buffer for the next chunk.
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      events.push(parseEvent(block, performance.now() - startedAt));
      end = buffer.indexOf("\n\n");
    }
  }
  return events;
}

export async function postRun(
  applicationId: string,
  base = URLS.desk,
  headers: Record<string, string> = {},
): Promise<RunResult> {
  const startedAt = performance.now();
  const response = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ application_id: applicationId }),
    signal: AbortSignal.timeout(60_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const body = await response.text();
    return { status: response.status, contentType, events: [], firstMs: null, body };
  }
  const events = await readEvents(response.body, startedAt);
  return { status: response.status, contentType, events, firstMs: events[0]?.atMs ?? null };
}

const isObject = (data: unknown): data is Record<string, unknown> =>
  typeof data === "object" && data !== null;

/** One field of an event's JSON data, or undefined when the data is not an object or lacks it. */
export function dataField(event: SseEvent, name: string): unknown {
  if (!isObject(event.data)) return undefined;
  return event.data[name];
}

/** Whether an event's JSON data has this field at all, even with an empty value. */
export function hasDataField(event: SseEvent, name: string): boolean {
  return isObject(event.data) && name in event.data;
}

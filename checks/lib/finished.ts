// Make sure the finished permit desk is running, and find the trace of one application's run.
import { composeEnv, healthy, runCommand, URLS } from "../../world/cli/lib";
import { postRun } from "./sse";
import { type Span, spans, world } from "./world";

async function startFinished(): Promise<boolean> {
  await world();
  if (await healthy(`${URLS.finished}/healthz`)) return true;
  const composeUp = [
    ...["docker", "compose", "-f", "world/finished/compose.yaml", "up"],
    ...["-d", "--build", "--wait", "--wait-timeout", "180"],
  ];
  const result = await runCommand(composeUp, { env: composeEnv() });
  return result.code === 0 && (await healthy(`${URLS.finished}/healthz`, 20));
}

let ready: Promise<boolean> | null = null;
export function finished(): Promise<boolean> {
  ready ??= startFinished();
  return ready;
}

// A clean run: stable release v1, finished, not resumed after a kill.
function isCleanRunRoot(span: Span, applicationId: string): boolean {
  const attributes = span.attributes;
  return (
    !span.parent_span_id &&
    attributes["application.id"] === applicationId &&
    attributes["release.id"] === "v1" &&
    attributes["run.status"] === "done" &&
    attributes["run.resumed"] === false
  );
}

async function latestTrace(applicationId: string): Promise<Span[]> {
  const all = await spans();
  const roots = all.filter((span) => isCleanRunRoot(span, applicationId));
  const newestFirst = roots.sort((first, second) => second.start_ms - first.start_ms);
  const newest = newestFirst[0];
  if (!newest) return [];
  return all.filter((span) => span.trace_id === newest.trace_id);
}

/** The spans of the latest finished-desk run for this application. Runs it once if none yet. */
export async function traceOf(applicationId: string): Promise<Span[]> {
  let trace = await latestTrace(applicationId);
  if (!trace.length && (await finished())) {
    await fetch(`${URLS.register}/admin/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [applicationId] }),
    });
    await postRun(applicationId, URLS.finished, { "x-resident-id": `check-${Date.now()}` });
    // The trace desk receives spans a moment after the run ends, so look again for a few seconds.
    for (let i = 0; i < 10 && !trace.length; i++) {
      await Bun.sleep(500);
      trace = await latestTrace(applicationId);
    }
  }
  return trace;
}

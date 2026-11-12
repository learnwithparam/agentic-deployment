// Make sure the finished permit desk is running, and find the trace of one application's run.
import { sh, composeEnv, URLS, healthy } from "../../world/cli/lib";
import { world, spans } from "./world";
import { postRun } from "./sse";

let ready: Promise<boolean> | null = null;
export function finished(): Promise<boolean> {
  ready ??= (async () => {
    await world();
    if (await healthy(`${URLS.finished}/healthz`)) return true;
    const r = await sh(["docker", "compose", "-f", "world/finished/compose.yaml", "up", "-d", "--build", "--wait", "--wait-timeout", "180"], { env: composeEnv() });
    return r.code === 0 && (await healthy(`${URLS.finished}/healthz`, 20));
  })();
  return ready;
}

/** The spans of the latest finished-desk run for this application. Runs it once if there is none yet. */
export async function traceOf(applicationId: string): Promise<any[]> {
  const find = async () => {
    const all = await spans();
    // A clean run: stable release v1, finished, not resumed after a kill.
    const roots = all.filter((s) => !s.parent_span_id && s.attributes["application.id"] === applicationId && s.attributes["release.id"] === "v1"
      && s.attributes["run.status"] === "done" && s.attributes["run.resumed"] === false)
      .sort((a, b) => b.start_ms - a.start_ms);
    return roots[0] ? all.filter((s) => s.trace_id === roots[0].trace_id) : [];
  };
  let t = await find();
  if (!t.length && (await finished())) {
    await fetch(`${URLS.register}/admin/reopen`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [applicationId] }) });
    await postRun(applicationId, URLS.finished, { "x-resident-id": `check-${Date.now()}` });
    for (let i = 0; i < 10 && !t.length; i++) { await Bun.sleep(500); t = await find(); }
  }
  return t;
}

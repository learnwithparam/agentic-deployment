// Plant a fault and watch what the desk does. Each one uses the replay model, so it costs nothing.
//   bun run chaos runaway [--desk]   send the runaway application HDC-2026-0177
//   bun run chaos kill [--desk]      stop the desk between the register write and the letter, then restart it
//   bun run chaos bad-canary         ship release v2 as a 10% canary to the finished desk and drive traffic
import { admin, composeEnv, gatewayProvider, healthy, resetWorld, sh, URLS } from "./lib";

const what = process.argv[2];
const toDesk = process.argv.includes("--desk");
const base = toDesk ? URLS.desk : URLS.finished;
const CONTROLLER = "http://localhost:7010";
const deskContainer = async () =>
  toDesk
    ? (
        await sh(["docker", "compose", "-p", "hdc-desk", "ps", "-q", "desk"], { env: composeEnv() })
      ).out.trim()
    : (
        await sh(
          ["docker", "compose", "-f", "world/finished/compose.yaml", "ps", "-q", "desk-stable"],
          { env: composeEnv() },
        )
      ).out.trim();
const reg = (p: string, body?: unknown) =>
  fetch(
    `${URLS.register}${p}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  ).then((r) => r.json() as Promise<any>);

async function run(id: string, resident = `chaos-${Date.now()}-${Math.random()}`) {
  const r = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-resident-id": resident },
    body: JSON.stringify({ application_id: id }),
  });
  const text = await r.text();
  const done = [...text.matchAll(/event: done\ndata: (.*)/g)].map((m) => JSON.parse(m[1])).at(-1);
  const error = [...text.matchAll(/event: error\ndata: (.*)/g)].map((m) => JSON.parse(m[1])).at(-1);
  return { status: r.status, done, error };
}

try {
  if ((await gatewayProvider()) !== "replay")
    throw new Error(
      "Chaos runs only with LLM_PROVIDER=replay, so it never spends real money. Set it in .env and restart the world.",
    );
  if (!(await healthy(`${base}/healthz`)))
    throw new Error(
      `Nothing answers on ${base}. Start it first: ${toDesk ? "bun run up <step-name>" : "bun run up finished"}`,
    );

  if (what === "runaway") {
    await reg("/admin/reopen", { ids: ["HDC-2026-0177"] });
    console.log(
      "Sending HDC-2026-0177, whose attachment list never ends. A desk with no brakes keeps going until the gateway budget runs out.",
    );
    const t0 = Date.now();
    const r = await Promise.race([run("HDC-2026-0177"), Bun.sleep(60_000).then(() => null)]);
    if (!r) {
      console.log("The run did not stop within 60 seconds. It has no step limit or dollar limit.");
      process.exit(1);
    }
    const spent = (await admin("/admin/spend")).filter((s: any) => s.run_id === r.done?.run_id);
    const cost = spent.reduce((a: number, s: any) => a + (s.cost_usd ?? 0), 0);
    console.log(
      `The run ended: ${r.done?.status ?? "no done event"} after ${spent.length} model calls, $${cost.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(1)} s.`,
    );
    if (r.error) console.log(`The resident saw: ${r.error.message}`);
  } else if (what === "kill") {
    const id = "HDC-2026-0142";
    await reg("/admin/reopen", { ids: [id] });
    await reg("/admin/chaos", { hold_letters_ms: 4000 });
    console.log(
      `Sending ${id}. The register will hold the letter call open, and the desk will be stopped while it waits.`,
    );
    const pending = run(id).catch(() => null);
    let decided = false;
    for (let i = 0; i < 40 && !decided; i++) {
      await Bun.sleep(250);
      decided = (await reg(`/applications/${id}`)).status !== "received";
    }
    if (!decided)
      throw new Error("The desk never wrote a decision, so there was nothing to interrupt.");
    const c = await deskContainer();
    await sh(["docker", "kill", c]);
    console.log("Decision written. Desk stopped before its letter was confirmed.");
    await reg("/admin/chaos", { hold_letters_ms: null });
    await pending;
    await sh(["docker", "start", c]);
    await healthy(`${base}/healthz`, 30);
    console.log("Desk restarted. Waiting for it to finish what it started.");
    await Bun.sleep(5000);
    const letters = await reg(`/letters?application_id=${id}`);
    const log = await reg("/audit");
    const since = Math.max(
      ...log
        .filter((a: any) => a.action === "reopen" && a.detail.ids?.includes(id))
        .map((a: any) => a.id),
    );
    const decisions = log.filter(
      (a: any) => a.id > since && a.application_id === id && a.action === "decision",
    );
    console.log(
      `Register: ${decisions.length} decision(s) and ${letters.length} letter(s) for ${id}. The goal is exactly 1 and 1.`,
    );
  } else if (what === "bad-canary") {
    if (toDesk)
      throw new Error(
        "bad-canary runs against the finished desk. Start it with: bun run up finished",
      );
    await resetWorld();
    await fetch(`${CONTROLLER}/reset`, { method: "POST" });
    // Wait until Prometheus has seen the empty register, so an old alert cannot roll back the new canary.
    for (let i = 0; i < 30; i++) {
      const a = (await (await fetch(`${URLS.prometheus}/api/v1/alerts`)).json()) as any;
      if (!a.data.alerts.length) break;
      await Bun.sleep(1000);
    }
    await fetch(`${CONTROLLER}/canary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ release: "v2", weight: 10 }),
    });
    console.log(
      "Release v2 is live as a canary on 10% of traffic. Sending residents' applications now. Nobody touches the keyboard from here.",
    );
    await Bun.sleep(3000);
    const ids = Array.from({ length: 40 }, (_, i) => `HDC-2026-0${140 + i}`).filter(
      (x) => x !== "HDC-2026-0177",
    );
    const t0 = Date.now();
    let sent = 0;
    for (;;) {
      const id = ids[sent % ids.length];
      await reg("/admin/reopen", { ids: [id] });
      await run(id).catch(() => null);
      sent++;
      await Bun.sleep(100);
      const s = (await (await fetch(`${CONTROLLER}/state`)).json()) as any;
      const rb = s.audit.find((a: any) => a.action === "rollback");
      if (rb) {
        console.log(
          `Alert ${rb.alert} fired for release ${rb.release}. The controller set the canary to 0%.`,
        );
        console.log(
          `Rolled back ${((Date.now() - t0) / 1000).toFixed(0)} s after the canary went live, after ${sent} applications, with no one at the keyboard.`,
        );
        break;
      }
      if (Date.now() - t0 > 180_000) {
        console.log(
          `No rollback within 3 minutes after ${sent} applications. Check http://localhost:9090/alerts.`,
        );
        process.exit(1);
      }
      if (sent % 40 === 0) console.log(`  ${sent} applications sent, canary still live...`);
    }
  } else {
    console.log(
      "Name a fault: bun run chaos runaway, bun run chaos kill, bun run chaos bad-canary",
    );
    process.exit(1);
  }
} catch (e) {
  console.log((e as Error).message);
  process.exit(2);
}

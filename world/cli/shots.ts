// bun run shots: retake every screenshot in the course from the running system (for course maintainers).
// Needs the world, the finished desk, and the sign-in-staff solution: bun run up finished && bun run up sign-in-staff solution
// Set PLAYWRIGHT_CHROMIUM to a Chromium binary if Playwright's own browser is not installed.
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { ROOT, URLS, sh, resetWorld, secret } from "./lib";

const out = (p: string) => { const f = join(ROOT, p); mkdirSync(join(f, ".."), { recursive: true }); return f; };
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1100, height: 680 }, deviceScaleFactor: 2 });
const reg = (p: string, b: unknown) => fetch(`${URLS.register}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

await resetWorld();

// The resident's page on the finished desk, after a streamed check.
await page.goto(URLS.finished);
await page.selectOption("#app", "HDC-2026-0142");
await page.click("#go");
await page.waitForSelector(".done", { timeout: 20_000 });
await page.screenshot({ path: out("images/finished-system.png") });

// A few more runs so the register and the trace desk have something to show.
for (const id of ["HDC-2026-0145", "HDC-2026-0150", "HDC-2026-0153"]) {
  await fetch(`${URLS.finished}/v1/runs`, { method: "POST", headers: { "content-type": "application/json", "x-resident-id": id }, body: JSON.stringify({ application_id: id }) }).then((r) => r.text());
}
await Bun.sleep(1500); // spans are sent in batches

// The trace desk, with the HDC-2026-0142 trace open.
await page.goto(URLS.traces);
await page.waitForSelector(".t");
await page.locator(".t", { hasText: "HDC-2026-0142" }).first().click();
await page.waitForSelector(".row");
await page.screenshot({ path: out("00-orientation/images/trace-desk.png") });

// The register after the runs.
await page.goto(URLS.register);
await page.screenshot({ path: out("00-orientation/meet-the-council/images/expected.png") });

// The staff queue on the sign-in-staff solution, signed in as an officer.
await reg("/applications/HDC-2026-0151/decision", { status: "valid_awaiting_officer", missing_items: [] });
await reg("/applications/HDC-2026-0160/decision", { status: "valid_awaiting_officer", missing_items: [] });
await page.goto(`${URLS.desk}/staff`);
await page.fill("input[name=username]", "amara.okafor");
await page.fill("input[name=password]", JSON.parse(secret("passwords"))["amara.okafor"]);
await page.click("button");
await page.waitForSelector("table");
await page.screenshot({ path: out("parts/01-ship-the-desk/03-sign-in-staff/images/expected.png") });

// A terminal: the streamed run from the command line, rendered about 800 pixels wide.
await reg("/admin/reopen", { ids: ["HDC-2026-0142"] });
const run = await sh(["bun", "world/cli/run-application.ts", "HDC-2026-0142", "--desk"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const term = await browser.newPage({ viewport: { width: 800, height: 300 }, deviceScaleFactor: 2 });
await term.setContent(`<body style="margin:0;background:#0f1115"><div style="font:13px/1.55 ui-monospace,Menlo,monospace;color:#d6d8dc;padding:18px 20px;white-space:pre-wrap">
<span style="color:#7fd1b9">$</span> bun run run-application HDC-2026-0142 --desk
${esc(run.out.replace(/^\n+/, "").trimEnd())}</div></body>`);
await term.screenshot({ path: out("parts/01-ship-the-desk/01-package-the-agent/images/expected.png"), fullPage: true });

await browser.close();
console.log("Screenshots written: images/, 00-orientation/images/, and each screen step's images/expected.png.");
void readFileSync;

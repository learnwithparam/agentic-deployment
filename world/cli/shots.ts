// biome-ignore-all lint/style/useNamingConvention: the desk JSON uses names like application_id
// bun run shots: retake every screenshot in the course from the running system (for maintainers).
// Needs the world, the finished desk, and the sign-in-staff solution:
//   bun run up finished && bun run up sign-in-staff solution
// Set PLAYWRIGHT_CHROMIUM to a Chromium binary if Playwright's own browser is not installed.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { ROOT, resetWorld, runCommand, secret, URLS } from "./lib";

/** The full path for a screenshot, making its folder if needed. */
function imagePath(relativePath: string): string {
  const file = join(ROOT, relativePath);
  mkdirSync(join(file, ".."), { recursive: true });
  return file;
}

function postToRegister(path: string, body: unknown) {
  return fetch(`${URLS.register}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
const page = await browser.newPage({
  viewport: { width: 1100, height: 680 },
  deviceScaleFactor: 2,
});

await resetWorld();

// The resident's page on the finished desk, after a streamed check.
await page.goto(URLS.finished);
await page.selectOption("#app", "HDC-2026-0142");
await page.click("#go");
await page.waitForSelector(".done", { timeout: 20_000 });
await page.screenshot({ path: imagePath("images/finished-system.png") });

// A few more runs so the register and the trace desk have something to show.
for (const id of ["HDC-2026-0145", "HDC-2026-0150", "HDC-2026-0153"]) {
  const response = await fetch(`${URLS.finished}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-resident-id": id },
    body: JSON.stringify({ application_id: id }),
  });
  await response.text();
}
// Spans are sent in batches, so give the last batch time to arrive.
await Bun.sleep(1500);

// The trace desk, with the HDC-2026-0142 trace open.
await page.goto(URLS.traces);
await page.waitForSelector(".t");
const traceEntry = page.locator(".t", { hasText: "HDC-2026-0142" });
await traceEntry.first().click();
await page.waitForSelector(".row");
await page.screenshot({ path: imagePath("00-orientation/images/trace-desk.png") });

// The register after the runs.
await page.goto(URLS.register);
await page.screenshot({ path: imagePath("00-orientation/meet-the-council/images/expected.png") });

// The staff queue on the sign-in-staff solution, signed in as an officer.
const readyForOfficer = { status: "valid_awaiting_officer", missing_items: [] };
await postToRegister("/applications/HDC-2026-0151/decision", readyForOfficer);
await postToRegister("/applications/HDC-2026-0160/decision", readyForOfficer);
await page.goto(`${URLS.desk}/staff`);
await page.fill("input[name=username]", "amara.okafor");
const passwords = JSON.parse(secret("passwords"));
await page.fill("input[name=password]", passwords["amara.okafor"]);
await page.click("button");
await page.waitForSelector("table");
await page.screenshot({
  path: imagePath("parts/01-ship-the-desk/03-sign-in-staff/images/expected.png"),
});

// A terminal: the streamed run from the command line, rendered about 800 pixels wide.
await postToRegister("/admin/reopen", { ids: ["HDC-2026-0142"] });
const run = await runCommand(["bun", "world/cli/run-application.ts", "HDC-2026-0142", "--desk"]);
const printed = run.out.replace(/^\n+/, "").trimEnd();
const terminal = await browser.newPage({
  viewport: { width: 800, height: 300 },
  deviceScaleFactor: 2,
});
const terminalStyle =
  "font:13px/1.55 ui-monospace,Menlo,monospace;color:#d6d8dc;" +
  "padding:18px 20px;white-space:pre-wrap";
await terminal.setContent(`<body style="margin:0;background:#0f1115"><div style="${terminalStyle}">
<span style="color:#7fd1b9">$</span> bun run run-application HDC-2026-0142 --desk
${escapeHtml(printed)}</div></body>`);
await terminal.screenshot({
  path: imagePath("parts/01-ship-the-desk/01-package-the-agent/images/expected.png"),
  fullPage: true,
});

await browser.close();
console.log(
  "Screenshots written: images/, 00-orientation/images/, " +
    "and each screen step's images/expected.png.",
);

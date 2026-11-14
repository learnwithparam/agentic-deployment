// bun run text-audit: opens every route in a real browser and runs the 10 text checks.
// A repo with no e2e/routes.ts has no pages yet, so there is nothing to audit.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./structure";

const routesFile = join(ROOT, "e2e", "routes.ts");

if (!existsSync(routesFile)) {
  console.log("Text audit skipped: e2e/routes.ts does not exist yet.");
  console.log("Try next: copy e2e/routes.example.ts to e2e/routes.ts when the course has pages.");
  process.exit(0);
}

const configFile = join(ROOT, "e2e", "playwright.config.ts");
const install = Bun.spawnSync(["bunx", "playwright", "install", "chromium"], { cwd: ROOT });
if (install.exitCode !== 0) {
  console.error("Could not get the browser. Try next: run bunx playwright install chromium.");
  process.exit(2);
}
const audit = Bun.spawnSync(["bunx", "playwright", "test", "-c", configFile, "--trace", "off"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (audit.exitCode !== 0) {
  console.error("The text audit found problems. Try next: fix the lines marked above, then rerun.");
}
process.exit(audit.exitCode === 0 ? 0 : 1);

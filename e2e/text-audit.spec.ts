// The shared text audit: 10 checks on every route and state, at 1280 px and 375 px wide.
// The checks live in page-checks.js, because they run inside the browser.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const HERE = import.meta.dirname;
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 375, height: 800 },
];

type Target = { name: string; path: string; prepare?: (page: Page) => Promise<void> };
type CourseFiles = { targets: Target[]; extraVerbs: string[] };

async function loadCourseFiles(): Promise<CourseFiles> {
  const routesFile = join(HERE, "routes.ts");
  if (!existsSync(routesFile)) throw new Error("Copy e2e/routes.example.ts to e2e/routes.ts.");
  const routesModule = await import(routesFile);
  const statesFile = join(HERE, "states.ts");
  const statesModule = existsSync(statesFile) ? await import(statesFile) : { states: [] };
  return {
    targets: [...routesModule.routes, ...statesModule.states],
    extraVerbs: routesModule.extraButtonVerbs ?? [],
  };
}

async function runChecks(page: Page, extraVerbs: string[]): Promise<Record<string, string[]>> {
  await page.addScriptTag({ path: join(HERE, "page-checks.js") });
  const options = JSON.stringify({ extraVerbs });
  return page.evaluate(`textAudit.run(${options})`) as Promise<Record<string, string[]>>;
}

async function openTarget(page: Page, target: Target) {
  await page.goto(target.path);
  await page.waitForLoadState("networkidle");
  if (target.prepare) await target.prepare(page);
}

const course = await loadCourseFiles();

for (const viewport of VIEWPORTS) {
  for (const target of course.targets) {
    test(`${target.name} at ${viewport.width} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openTarget(page, target);
      const results = await runChecks(page, course.extraVerbs);
      for (const [check, problems] of Object.entries(results)) {
        expect.soft(problems, check).toEqual([]);
      }
    });
  }
}

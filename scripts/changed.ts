// bun run check:changed: run only the checks a pull request can affect.
// Compares against the merge-base with origin/main. Anything under scripts/, checks/ or
// package.json can change what every check means, so those run the full `bun run check`.
//
// Test hooks: CHANGED_ROOT picks the repo to read, CHANGED_BASE the base ref,
// and --dry-run prints the plan without running anything.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bareName } from "./structure";

const root = process.env.CHANGED_ROOT ?? join(import.meta.dir, "..");
const baseRef = process.env.CHANGED_BASE ?? "origin/main";
const dryRun = process.argv.includes("--dry-run");

type Step = { label: string; command: string[]; why: string };
type Plan = { run: Step[]; skipped: string[] };

function git(...args: string[]): string {
  const done = Bun.spawnSync(["git", ...args], { cwd: root });
  if (done.exitCode !== 0) {
    const reason = done.stderr.toString().trim();
    console.error(`git ${args.join(" ")} failed: ${reason}`);
    process.exit(2);
  }
  return done.stdout.toString().trim();
}

function changedFiles(): string[] {
  const base = git("merge-base", baseRef, "HEAD");
  // Diffing against the base (not base...HEAD) also sees edits not yet committed.
  const names = git("diff", "--name-only", base);
  return names.split("\n").filter(Boolean);
}

const touchesEverything = (file: string) =>
  file.startsWith("scripts/") || file.startsWith("checks/") || file === "package.json";

// parts/<part>/<step>/... is a step folder. The step name drops the order prefix.
function stepOf(file: string): string | undefined {
  const [top, , stepFolder, ...rest] = file.split("/");
  if (top !== "parts" || !stepFolder || rest.length === 0) return undefined;
  return bareName(stepFolder);
}

// A check from another seat may not be merged yet. No file means no step, quietly.
const scriptExists = (name: string) => existsSync(join(root, "scripts", name));

function pageAndStepSteps(files: string[], steps: Step[], skipped: string[]) {
  const pages = files.filter((file) => file.endsWith(".md") && existsSync(join(root, file)));
  if (pages.length > 0) {
    const why = `${pages.length} changed .md file(s)`;
    steps.push({ label: "prose", command: ["bun", "scripts/plain-english.ts", ...pages], why });
    steps.push({ label: "shape", command: ["bun", "scripts/check.ts"], why });
  } else {
    skipped.push("prose and shape: no .md file changed");
  }
  const changedSteps = [...new Set(files.map(stepOf).filter((name) => name !== undefined))];
  if (changedSteps.length === 0) {
    skipped.push("verify: no step folder changed");
    return;
  }
  const why = `step folder changed: ${changedSteps.join(", ")}`;
  const command = ["bun", "scripts/verify.ts", "--all", ...changedSteps];
  steps.push({ label: `verify ${changedSteps.join(", ")}`, command, why });
}

const isPartReadme = (file: string) => /^parts\/[^/]+\/README\.md$/.test(file);
const OPTIONAL_CHECKS: [string, string, (file: string) => boolean][] = [
  ["capstone", "capstone.ts", (file) => file.startsWith("capstone/")],
  ["picks", "picks.ts", (file) => isPartReadme(file) || file === "picks.denylist.json"],
  ["ladder", "ladder.ts", (file) => file === "ladder.toml"],
];

export function plan(files: string[], hasScript = scriptExists): Plan {
  const steps: Step[] = [];
  const skipped: string[] = [];
  const trigger = files.find(touchesEverything);
  if (trigger) {
    const why = `${trigger} changed, so every check may be affected`;
    return { run: [{ label: "full check", command: ["bun", "run", "check"], why }], skipped: [] };
  }
  pageAndStepSteps(files, steps, skipped);
  for (const [label, script, isTrigger] of OPTIONAL_CHECKS) {
    if (!hasScript(script)) continue;
    const hit = files.find(isTrigger);
    if (hit) steps.push({ label, command: ["bun", `scripts/${script}`], why: `${hit} changed` });
    else skipped.push(`${label}: none of its files changed`);
  }
  return { run: steps, skipped };
}

if (import.meta.main) {
  const files = changedFiles();
  const { run, skipped } = plan(files);
  console.log(`Changed files against ${baseRef}: ${files.length}`);
  for (const step of run) console.log(`RUN   ${step.label} (${step.why})`);
  for (const line of skipped) console.log(`SKIP  ${line}`);
  if (dryRun) process.exit(0);
  let failed = false;
  for (const step of run) {
    console.log(`\n== ${step.label}`);
    const done = Bun.spawnSync(step.command, { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (done.exitCode !== 0) failed = true;
  }
  if (failed) {
    console.error("\nA check failed. Fix the lines above and run it again.");
    process.exit(1);
  }
  console.log("\nEvery check that applies to this change passed.");
}

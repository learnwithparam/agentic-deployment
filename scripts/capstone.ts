// bun run capstone: a course's capstone must fail on its empty template and pass on its sample.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./structure";

// The check judges the learner's artefact only; a world path would break for every learner.
const NO_CAPSTONE =
  "this course has no capstone/ folder; add capstone/template, capstone/sample, capstone/check.ts";
const READS_WORLD = /["'`/]world[/"'`]/;

export function runArtefactCheck(checkFile: string, artefact: string): boolean {
  const result = Bun.spawnSync(["bun", checkFile, artefact], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0;
}

export function capstoneProblems(capstoneFolder: string): string[] {
  const checkFile = join(capstoneFolder, "check.ts");
  const template = join(capstoneFolder, "template");
  const sample = join(capstoneFolder, "sample");
  const missing = [checkFile, template, sample].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    return [`capstone/ needs check.ts, template/ and sample/; missing: ${missing.join(", ")}`];
  }
  const problems: string[] = [];
  if (READS_WORLD.test(readFileSync(checkFile, "utf8"))) {
    problems.push("capstone/check.ts must not read world/; it only judges the learner's artefact");
  }
  if (runArtefactCheck(checkFile, template)) {
    problems.push("the check passes on capstone/template; the template is empty, so it must fail");
  }
  if (!runArtefactCheck(checkFile, sample)) {
    problems.push("the check fails on capstone/sample; the sample is filled, so it must pass");
  }
  return problems;
}

function capstoneIsRequired(): boolean {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return manifest.capstone === true;
}

function problemsForCourse(): string[] {
  const folder = join(ROOT, "capstone");
  if (existsSync(folder)) return capstoneProblems(folder);
  if (!capstoneIsRequired()) return [];
  return [NO_CAPSTONE];
}

if (import.meta.main) {
  const problems = problemsForCourse();
  if (problems.length > 0) {
    console.log(`The capstone does not meet the standard. ${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exit(1);
  }
  const hasCapstone = existsSync(join(ROOT, "capstone"));
  console.log(
    hasCapstone
      ? "The capstone fails on the template and passes on the sample."
      : "No capstone yet; it is off.",
  );
}

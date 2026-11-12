// bun run verify <step-name>            check your work on one step, then show progress
// bun run verify <step-name> solution   check the sample solution instead
// bun run verify part <part-name>      check every step in one part (a deliverable)
// bun run verify --report               write verify-report.json for cohort grading
// bun run verify --all                  CI: each check fails on its starter and wrong answers,
//                                       and passes on its solution
// Exit codes: 0 pass, 1 fail, 2 the check could not run.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allSteps, findStep, type Part, parts, ROOT, type Step } from "./structure";

export type Rule = {
  says: string;
  test: (dir: string) => boolean | Promise<boolean>;
  tryNext: string;
};
type Result = {
  step: string;
  status: "pass" | "fail" | "error";
  passed: number;
  total: number;
  failed: string[];
};

async function rulesFor(step: Step): Promise<Rule[]> {
  const checkModule = await import(join(ROOT, "checks", `${step.name}.ts`));
  return checkModule.default;
}

// A rule that throws counts as a failed rule, never as a crash.
async function rulePasses(rule: Rule, dir: string): Promise<boolean> {
  try {
    return await rule.test(dir);
  } catch {
    return false;
  }
}

function printRule(rule: Rule, ok: boolean) {
  if (ok) {
    console.log(`  PASS  ${rule.says}`);
  } else {
    console.log(`  FAIL  ${rule.says}\n        Try next: ${rule.tryNext}`);
  }
}

async function run(step: Step, dir: string, print = false): Promise<Result> {
  let rules: Rule[];
  try {
    rules = await rulesFor(step);
  } catch (error) {
    if (print) {
      const reason = (error as Error).message;
      console.log(`  ERROR  the check for ${step.name} could not load: ${reason}`);
    }
    return { step: step.name, status: "error", passed: 0, total: 0, failed: [] };
  }
  const failed: string[] = [];
  for (const rule of rules) {
    const ok = await rulePasses(rule, dir);
    if (!ok) failed.push(rule.says);
    if (print) printRule(rule, ok);
  }
  const passed = rules.length - failed.length;
  return {
    step: step.name,
    status: failed.length ? "fail" : "pass",
    passed,
    total: rules.length,
    failed,
  };
}

const work = (step: Step) => join(step.dir, "problem");

function wrongAnswers(step: Step): { name: string; dir: string }[] {
  const wrongFolder = join(step.dir, "wrong");
  if (!existsSync(wrongFolder)) {
    return [];
  }
  const names = readdirSync(wrongFolder);
  return names.map((name) => ({ name, dir: join(wrongFolder, name) }));
}

// Everything wrong with one step's check, as plain sentences.
async function problemsWithCheck(step: Step): Promise<string[]> {
  let rules: Rule[] = [];
  try {
    rules = await rulesFor(step);
  } catch (error) {
    return [`${step.name}: the check could not load: ${(error as Error).message}`];
  }
  const problems: string[] = [];
  for (const rule of rules) {
    const wordCount = rule.tryNext.trim().split(/\s+/).length;
    if (wordCount < 3) problems.push(`${step.name}: rule "${rule.says}" needs a try-next sentence`);
  }
  if ((await run(step, work(step))).status === "pass") {
    problems.push(`${step.name}: the check passes on the starter, so it checks nothing`);
  }
  if (!existsSync(join(step.dir, "solution"))) {
    problems.push(`${step.name}: needs solution/ so CI can prove the check can pass`);
  } else {
    const solution = await run(step, join(step.dir, "solution"));
    if (solution.status !== "pass") {
      problems.push(`${step.name}: the sample solution fails: ${solution.failed.join("; ")}`);
    }
  }
  problems.push(...(await problemsWithWrongAnswers(step)));
  return problems;
}

async function problemsWithWrongAnswers(step: Step): Promise<string[]> {
  const problems: string[] = [];
  const wrong = wrongAnswers(step);
  if (wrong.length === 0) {
    problems.push(
      `${step.name}: needs at least one wrong/<mistake>/ answer that the check must reject`,
    );
  }
  for (const answer of wrong) {
    if ((await run(step, answer.dir)).status === "pass") {
      problems.push(`${step.name}: wrong answer "${answer.name}" passes the check`);
    }
  }
  return problems;
}

async function checkEveryCheck(): Promise<never> {
  const problems: string[] = [];
  for (const step of allSteps()) {
    problems.push(...(await problemsWithCheck(step)));
  }
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length) {
    console.log(`${problems.length} check problem(s).`);
    process.exit(1);
  }
  console.log("Every check rejects its starter and wrong answers, and passes its solution.");
  process.exit(0);
}

async function runEveryStep(): Promise<Result[]> {
  const results: Result[] = [];
  for (const step of allSteps()) results.push(await run(step, work(step)));
  return results;
}

const countPassing = (results: Result[]) =>
  results.filter((result) => result.status === "pass").length;

async function writeReport(): Promise<never> {
  const results = await runEveryStep();
  const reportPath = join(ROOT, "verify-report.json");
  const report = { version: 1, at: new Date().toISOString(), results };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const passing = countPassing(results);
  console.log(`Wrote verify-report.json: ${passing} of ${results.length} steps pass.`);
  process.exit(0);
}

function listParts(partName: string | undefined): never {
  if (partName) {
    console.log(`There is no part called "${partName}". Parts:`);
  } else {
    console.log("Name a part. Parts:");
  }
  for (const part of parts()) console.log(`  bun run verify part ${part.name}`);
  process.exit(1);
}

function partExitCode(results: Result[], done: number): number {
  if (results.some((result) => result.status === "error")) return 2;
  if (done === results.length) return 0;
  return 1;
}

async function verifyPart(part: Part): Promise<never> {
  console.log(`Part ${part.name}:`);
  const results: Result[] = [];
  for (const step of part.steps) {
    const result = await run(step, work(step));
    results.push(result);
    const label = result.status.toUpperCase().padEnd(5);
    console.log(`  ${label}  ${step.name}  (${result.passed}/${result.total} rules)`);
  }
  const done = countPassing(results);
  if (done === results.length) {
    console.log(`Part ${part.name} is done: ${done}/${results.length} steps pass.`);
  } else {
    const advice = "Run bun run verify <step-name> on a FAIL line to see why.";
    console.log(`${done}/${results.length} steps pass. ${advice}`);
  }
  process.exit(partExitCode(results, done));
}

function listSteps(stepName: string | undefined): never {
  if (stepName) {
    console.log(`There is no step called "${stepName}". Steps:`);
  } else {
    console.log("Name a step. Steps:");
  }
  for (const step of allSteps()) console.log(`  bun run verify ${step.name}`);
  process.exit(1);
}

async function verifyStep(step: Step, asSolution: boolean): Promise<never> {
  const whose = asSolution ? "sample solution" : "your work";
  console.log(`Checking ${step.name} (${whose}):`);
  const dir = asSolution ? join(step.dir, "solution") : work(step);
  const result = await run(step, dir, true);
  if (result.status === "error") process.exit(2);
  if (result.status === "pass") {
    console.log(`Done. All ${result.total} rules pass.`);
  } else {
    console.log(
      `${result.passed} of ${result.total} rules pass. Fix the FAIL lines and run it again.`,
    );
  }
  if (!asSolution) {
    // Done is recomputed from the checks every time, never read from a saved flag.
    const everyResult = await runEveryStep();
    console.log(`Progress: ${countPassing(everyResult)}/${everyResult.length} steps pass.`);
  }
  process.exit(result.status === "pass" ? 0 : 1);
}

const [command, which] = process.argv.slice(2);

if (command === "--all") await checkEveryCheck();
if (command === "--report") await writeReport();
if (command === "part") {
  const part = parts().find((candidate) => candidate.name === which);
  if (!part) listParts(which);
  await verifyPart(part);
}
const step = command && findStep(command);
if (!step) listSteps(command);
await verifyStep(step, which === "solution");

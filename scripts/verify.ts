// bun run verify <step-name>           check your work on one step, then show all progress
// bun run verify <step-name> solution  check the sample solution instead
// bun run verify part <part-name>      check every step in one part (a deliverable)
// bun run verify --report              write verify-report.json for cohort grading
// bun run verify --all                 CI: each check fails on its starter and wrong answers,
//                                      and passes on its solution
// Exit codes: 0 pass, 1 fail, 2 the check could not run.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allSteps, findStep, parts, ROOT, type Step } from "./structure";

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
  return (await import(join(ROOT, "checks", `${step.name}.ts`))).default;
}

async function ruleHolds(rule: Rule, folder: string): Promise<boolean> {
  try {
    return await rule.test(folder);
  } catch {
    // A rule that crashes counts as not met, so the learner sees a FAIL line to act on.
    return false;
  }
}

function printRuleLine(rule: Rule, holds: boolean) {
  if (holds) console.log(`  PASS  ${rule.says}`);
  else console.log(`  FAIL  ${rule.says}\n        Try next: ${rule.tryNext}`);
}

async function run(step: Step, folder: string, print = false): Promise<Result> {
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
    const holds = await ruleHolds(rule, folder);
    if (!holds) failed.push(rule.says);
    if (print) printRuleLine(rule, holds);
  }
  const passed = rules.length - failed.length;
  const status = failed.length ? "fail" : "pass";
  return { step: step.name, status, passed, total: rules.length, failed };
}

const starterFolder = (step: Step) => join(step.dir, "problem");

function wrongAnswers(step: Step): { name: string; dir: string }[] {
  const wrongFolder = join(step.dir, "wrong");
  if (!existsSync(wrongFolder)) return [];
  return readdirSync(wrongFolder).map((name) => ({ name, dir: join(wrongFolder, name) }));
}

const countPassing = (results: Result[]) => results.filter((result) => result.status === "pass");

const [firstArgument, secondArgument] = process.argv.slice(2);

function problemsWithTryNext(step: Step, rules: Rule[]): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const wordCount = rule.tryNext.trim().split(/\s+/).length;
    if (wordCount < 3) problems.push(`${step.name}: rule "${rule.says}" needs a try-next sentence`);
  }
  return problems;
}

async function problemsWithSolution(step: Step): Promise<string[]> {
  const solutionFolder = join(step.dir, "solution");
  if (!existsSync(solutionFolder)) {
    return [`${step.name}: needs solution/ so CI can prove the check can pass`];
  }
  const outcome = await run(step, solutionFolder);
  if (outcome.status === "pass") return [];
  return [`${step.name}: the sample solution fails: ${outcome.failed.join("; ")}`];
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
    const outcome = await run(step, answer.dir);
    if (outcome.status === "pass") {
      problems.push(`${step.name}: wrong answer "${answer.name}" passes the check`);
    }
  }
  return problems;
}

async function problemsWithStep(step: Step): Promise<string[]> {
  let rules: Rule[];
  try {
    rules = await rulesFor(step);
  } catch (error) {
    // When the check cannot load, nothing else about this step can be tried.
    return [`${step.name}: the check could not load: ${(error as Error).message}`];
  }
  const problems = problemsWithTryNext(step, rules);
  const starter = await run(step, starterFolder(step));
  if (starter.status === "pass") {
    problems.push(`${step.name}: the check passes on the starter, so it checks nothing`);
  }
  problems.push(...(await problemsWithSolution(step)));
  problems.push(...(await problemsWithWrongAnswers(step)));
  return problems;
}

async function verifyEveryCheck(onlySteps: string[] = []): Promise<never> {
  const problems: string[] = [];
  const chosen = allSteps().filter(
    (step) => onlySteps.length === 0 || onlySteps.includes(step.name),
  );
  for (const step of chosen) problems.push(...(await problemsWithStep(step)));
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length > 0) console.log(`${problems.length} check problem(s).`);
  else console.log("Every check rejects its starter and wrong answers, and passes its solution.");
  process.exit(problems.length > 0 ? 1 : 0);
}

async function writeReport(): Promise<never> {
  const results: Result[] = [];
  for (const step of allSteps()) results.push(await run(step, starterFolder(step)));
  const report = { version: 1, at: new Date().toISOString(), results };
  writeFileSync(join(ROOT, "verify-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const passing = countPassing(results).length;
  console.log(`Wrote verify-report.json: ${passing} of ${results.length} steps pass.`);
  process.exit(0);
}

function listPartsAndStop(): never {
  if (secondArgument) console.log(`There is no part called "${secondArgument}". Parts:`);
  else console.log("Name a part. Parts:");
  for (const part of parts()) console.log(`  bun run verify part ${part.name}`);
  process.exit(1);
}

function partExitCode(results: Result[]): number {
  if (results.some((result) => result.status === "error")) return 2;
  return countPassing(results).length === results.length ? 0 : 1;
}

async function verifyOnePart(): Promise<never> {
  const part = parts().find((candidate) => candidate.name === secondArgument);
  if (!part) return listPartsAndStop();
  console.log(`Part ${part.name}:`);
  const results: Result[] = [];
  for (const step of part.steps) {
    const result = await run(step, starterFolder(step));
    results.push(result);
    const label = result.status.toUpperCase().padEnd(5);
    console.log(`  ${label}  ${step.name}  (${result.passed}/${result.total} rules)`);
  }
  const done = countPassing(results).length;
  const summary = `${done}/${results.length} steps pass.`;
  if (done === results.length) console.log(`Part ${part.name} is done: ${summary}`);
  else console.log(`${summary} Run bun run verify <step-name> on a FAIL line to see why.`);
  process.exit(partExitCode(results));
}

function listStepsAndStop(): never {
  if (firstArgument) console.log(`There is no step called "${firstArgument}". Steps:`);
  else console.log("Name a step. Steps:");
  for (const step of allSteps()) console.log(`  bun run verify ${step.name}`);
  process.exit(1);
}

async function printProgress() {
  // Done is recomputed from the checks every time, never read from a saved flag.
  const everyResult: Result[] = [];
  for (const step of allSteps()) everyResult.push(await run(step, starterFolder(step)));
  const passing = countPassing(everyResult).length;
  console.log(`Progress: ${passing}/${everyResult.length} steps pass.`);
}

async function verifyOneStep(step: Step): Promise<never> {
  const asSolution = secondArgument === "solution";
  const whose = asSolution ? "sample solution" : "your work";
  console.log(`Checking ${step.name} (${whose}):`);
  const folder = asSolution ? join(step.dir, "solution") : starterFolder(step);
  const result = await run(step, folder, true);
  if (result.status === "error") process.exit(2);
  if (result.status === "pass") {
    console.log(`Done. All ${result.total} rules pass.`);
  } else {
    console.log(
      `${result.passed} of ${result.total} rules pass. Fix the FAIL lines and run it again.`,
    );
  }
  if (!asSolution) await printProgress();
  process.exit(result.status === "pass" ? 0 : 1);
}

if (import.meta.main) {
  if (firstArgument === "--all") await verifyEveryCheck(process.argv.slice(3));
  if (firstArgument === "--report") await writeReport();
  if (firstArgument === "part") await verifyOnePart();
  const step = firstArgument ? findStep(firstArgument) : undefined;
  if (!step) listStepsAndStop();
  await verifyOneStep(step);
}

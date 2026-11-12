// bun run verify <step-name>            check your work on one step, then show progress on every step
// bun run verify <step-name> solution   check the sample solution instead
// bun run verify part <part-name>      check every step in one part (a deliverable)
// bun run verify --report               write verify-report.json for cohort grading
// bun run verify --all                  CI: each check fails on its starter and wrong answers, passes on its solution
// Exit codes: 0 pass, 1 fail, 2 the check could not run.
import { join } from "node:path";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { ROOT, allSteps, findStep, parts, type Step } from "./structure";

export type Rule = { says: string; test: (dir: string) => boolean | Promise<boolean>; tryNext: string };
type Result = { step: string; status: "pass" | "fail" | "error"; passed: number; total: number; failed: string[] };

async function rulesFor(step: Step): Promise<Rule[]> {
  return (await import(join(ROOT, "checks", `${step.name}.ts`))).default;
}

async function run(step: Step, dir: string, print = false): Promise<Result> {
  let rules: Rule[];
  try { rules = await rulesFor(step); } catch (e) {
    if (print) console.log(`  ERROR  the check for ${step.name} could not load: ${(e as Error).message}`);
    return { step: step.name, status: "error", passed: 0, total: 0, failed: [] };
  }
  const failed: string[] = [];
  for (const r of rules) {
    let ok = false;
    try { ok = await r.test(dir); } catch { ok = false; }
    if (!ok) failed.push(r.says);
    if (print) console.log(ok ? `  PASS  ${r.says}` : `  FAIL  ${r.says}\n        Try next: ${r.tryNext}`);
  }
  const passed = rules.length - failed.length;
  return { step: step.name, status: failed.length ? "fail" : "pass", passed, total: rules.length, failed };
}

const work = (s: Step) => join(s.dir, "problem");
const wrongAnswers = (s: Step) => {
  const w = join(s.dir, "wrong");
  return existsSync(w) ? readdirSync(w).map((d) => ({ name: d, dir: join(w, d) })) : [];
};

const [arg, which] = process.argv.slice(2);

if (arg === "--all") {
  const bad: string[] = [];
  for (const s of allSteps()) {
    let rules: Rule[] = [];
    try { rules = await rulesFor(s); } catch (e) { bad.push(`${s.name}: the check could not load: ${(e as Error).message}`); continue; }
    for (const r of rules) if (r.tryNext.trim().split(/\s+/).length < 3) bad.push(`${s.name}: rule "${r.says}" needs a try-next sentence`);
    if ((await run(s, work(s))).status === "pass") bad.push(`${s.name}: the check passes on the starter, so it checks nothing`);
    if (!existsSync(join(s.dir, "solution"))) bad.push(`${s.name}: needs solution/ so CI can prove the check can pass`);
    else {
      const sol = await run(s, join(s.dir, "solution"));
      if (sol.status !== "pass") bad.push(`${s.name}: the sample solution fails: ${sol.failed.join("; ")}`);
    }
    const wrong = wrongAnswers(s);
    if (wrong.length === 0) bad.push(`${s.name}: needs at least one wrong/<mistake>/ answer that the check must reject`);
    for (const w of wrong) if ((await run(s, w.dir)).status === "pass") bad.push(`${s.name}: wrong answer "${w.name}" passes the check`);
  }
  for (const b of bad) console.log(`  ${b}`);
  console.log(bad.length ? `${bad.length} check problem(s).` : "Every check rejects its starter and wrong answers, and passes its solution.");
  process.exit(bad.length ? 1 : 0);
}

if (arg === "--report") {
  const results = [];
  for (const s of allSteps()) results.push(await run(s, work(s)));
  const out = join(ROOT, "verify-report.json");
  writeFileSync(out, JSON.stringify({ version: 1, at: new Date().toISOString(), results }, null, 2) + "\n");
  console.log(`Wrote verify-report.json: ${results.filter((r) => r.status === "pass").length} of ${results.length} steps pass.`);
  process.exit(0);
}

if (arg === "part") {
  const p = parts().find((x) => x.name === which);
  if (!p) {
    console.log(which ? `There is no part called "${which}". Parts:` : "Name a part. Parts:");
    for (const x of parts()) console.log(`  bun run verify part ${x.name}`);
    process.exit(1);
  }
  console.log(`Part ${p.name}:`);
  const rs = [];
  for (const s of p.steps) {
    const r = await run(s, work(s));
    rs.push(r);
    console.log(`  ${r.status.toUpperCase().padEnd(5)}  ${s.name}  (${r.passed}/${r.total} rules)`);
  }
  const done = rs.filter((r) => r.status === "pass").length;
  console.log(done === rs.length ? `Part ${p.name} is done: ${done}/${rs.length} steps pass.` : `${done}/${rs.length} steps pass. Run bun run verify <step-name> on a FAIL line to see why.`);
  process.exit(rs.some((r) => r.status === "error") ? 2 : done === rs.length ? 0 : 1);
}

const step = arg && findStep(arg);
if (!step) {
  console.log(arg ? `There is no step called "${arg}". Steps:` : "Name a step. Steps:");
  for (const s of allSteps()) console.log(`  bun run verify ${s.name}`);
  process.exit(1);
}
const asSolution = which === "solution";
console.log(`Checking ${step.name} (${asSolution ? "sample solution" : "your work"}):`);
const r = await run(step, asSolution ? join(step.dir, "solution") : work(step), true);
if (r.status === "error") process.exit(2);
console.log(r.status === "pass" ? `Done. All ${r.total} rules pass.` : `${r.passed} of ${r.total} rules pass. Fix the FAIL lines and run it again.`);
if (!asSolution) {
  // Done is recomputed from the checks every time, never read from a saved flag.
  const all = [];
  for (const s of allSteps()) all.push(await run(s, work(s)));
  console.log(`Progress: ${all.filter((x) => x.status === "pass").length}/${all.length} steps pass.`);
}
process.exit(r.status === "pass" ? 0 : 1);

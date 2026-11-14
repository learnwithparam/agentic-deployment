// bun run assignment [folder]    check the closing-part assignment, write assignment/result.json
// bun run assignment --prove     CI: pass on the reference solution, fail on the starter
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/structure";
import type { Rule } from "../scripts/verify";
import stepRules from "./release-on-cloud-run";

const STEP = join(
  ROOT,
  "parts",
  "06-deploy-the-agent-to-cloud-run-with-floci-gcp",
  "01-release-on-cloud-run",
);

const choiceRule: Rule = {
  says: "CHOICE.md names the secret volume limit and the traffic limit",
  test: (folder) => {
    const file = join(folder, "CHOICE.md");
    if (!existsSync(file)) return false;
    const text = readFileSync(file, "utf8").toLowerCase();
    return text.includes("secret") && text.includes("traffic");
  },
  tryNext: "Write CHOICE.md. Say when Cloud Run is better, and what the emulator did not do.",
};
const rules: Rule[] = [...stepRules, choiceRule];

type Line = { line: string; result: "pass" | "fail" };

async function grade(folder: string): Promise<Line[]> {
  const lines: Line[] = [];
  for (const rule of rules) {
    let ok = false;
    try {
      ok = await rule.test(folder);
    } catch {
      ok = false;
    }
    lines.push({ line: rule.says, result: ok ? "pass" : "fail" });
    if (!ok) console.log(`  FAIL  ${rule.says}\n        Try next: ${rule.tryNext}`);
  }
  return lines;
}

const allPass = (lines: Line[]) => lines.every((line) => line.result === "pass");

async function prove(): Promise<number> {
  const solution = await grade(join(STEP, "solution"));
  const starter = await grade(join(STEP, "problem"));
  console.log(`Reference solution: ${allPass(solution) ? "pass" : "FAIL"}`);
  const starterWord = allPass(starter) ? "PASSES, so it checks nothing" : "fail, as it should";
  console.log(`Untouched starter: ${starterWord}`);
  return allPass(solution) && !allPass(starter) ? 0 : 1;
}

async function main(): Promise<number> {
  if (process.argv[2] === "--prove") return prove();
  const folder = process.argv[2] ?? join(STEP, "problem");
  const lines = await grade(folder);
  writeFileSync(join(ROOT, "assignment", "result.json"), `${JSON.stringify({ lines }, null, 2)}\n`);
  for (const line of lines) if (line.result === "pass") console.log(`  PASS  ${line.line}`);
  const done = allPass(lines);
  console.log(done ? "Done. All Done-when lines pass." : "Not done yet. See the FAIL lines above.");
  return done ? 0 : 1;
}

process.exit(await main());

// Checks each Claude Code ladder feature (standard section 7) maps to a step with a check.
// Only runs when package.json has "ladder": true.
// Run: bun scripts/ladder.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findStep, ROOT } from "./structure";

function ladderTurnedOn(root: string): boolean {
  const packagePath = join(root, "package.json");
  const settings = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : {};
  return settings.ladder === true;
}

function problemForFeature(feature: string, stepName: unknown, root: string): string | undefined {
  if (typeof stepName !== "string" || stepName.trim() === "") {
    return `feature "${feature}" has no step`;
  }
  const step = findStep(stepName, root);
  if (!step) return `feature "${feature}" names step "${stepName}", which does not exist`;
  if (!existsSync(join(root, "checks", `${step.name}.ts`))) {
    return `feature "${feature}" uses step "${stepName}", which has no check script`;
  }
  return undefined;
}

export function checkRoot(root: string): string[] {
  if (!ladderTurnedOn(root)) {
    console.log("ladder: skipped, this course has not turned the ladder on");
    return [];
  }
  const tomlPath = join(root, "ladder.toml");
  if (!existsSync(tomlPath)) return ["ladder.toml is missing"];
  const table = Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>;
  const features = (table.features ?? {}) as Record<string, unknown>;
  const entries = Object.entries(features);
  if (entries.length === 0) return ["ladder.toml has no features"];
  const found = entries.map(([feature, stepName]) => problemForFeature(feature, stepName, root));
  return found.filter((problem): problem is string => problem !== undefined);
}

if (import.meta.main) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag > 0 ? join(process.cwd(), process.argv[rootFlag + 1]) : ROOT;
  const problems = checkRoot(root);
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length) process.exit(1);
  console.log("ladder: ok");
}

// biome-ignore-all lint/style/useNamingConvention: the runner prints JSON names like application_id
// bun run gate <release>: run the eval cases against one release, and block it when a case fails.
//   bun run gate v1     the release that is live today
//   bun run gate v2     the friendlier prompt the planning team wants
// The cases run inside the desk's own image as dry runs, so the gate never writes to the register.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Decision, type EvalCase, findProblems } from "./evals/checks";

const HERE = import.meta.dir;

function loadCases(): EvalCase[] {
  const caseFile = readFileSync(join(HERE, "evals", "cases.json"), "utf8");
  return JSON.parse(caseFile).cases as EvalCase[];
}

// Start the runner in a fresh container from this folder's image, built from your code.
function runCases(releaseName: string, applicationIds: string[]): Decision[] {
  const compose = ["docker", "compose", "-p", "hdc-desk", "-f", join(HERE, "compose.yaml")];
  const settings = [
    ...["-e", "DRY_RUN=1", "-e", "DESK_DATA=/tmp/evals", "-e", "SERVICE_VERSION=gate"],
    ...["-e", `RELEASE_FILE=/app/releases/${releaseName}.json`],
  ];
  const runner = ["desk", "bun", "src/evals.ts", ...applicationIds];
  const command = [...compose, "run", "--rm", "--build", "--no-deps", ...settings, ...runner];
  const finished = Bun.spawnSync(command, { cwd: HERE, stderr: "pipe" });
  const printed = finished.stdout.toString();
  if (finished.exitCode !== 0) {
    const errorLines = finished.stderr.toString().trim().split("\n");
    const lastLines = errorLines.slice(-5).join("\n");
    throw new Error(`The eval runner did not finish:\n${lastLines}`);
  }
  // Each case is one line of JSON. Other lines are the desk's own logs.
  const jsonLines = printed.split("\n").filter((line) => line.startsWith("{"));
  return jsonLines.map((line) => JSON.parse(line) as Decision);
}

// The problems with one case. A run that wrote no decision at all is a problem too.
function problemsFor(evalCase: EvalCase, decisions: Decision[]): string[] {
  const id = evalCase.application_id;
  const decision = decisions.find((candidate) => candidate.application_id === id);
  if (!decision?.status) return ["the agent wrote no decision"];
  return findProblems(evalCase, decision);
}

const releaseName = process.argv[2];
if (!releaseName || !existsSync(join(HERE, "releases", `${releaseName}.json`))) {
  console.log("Name a release in releases/, for example: bun run gate v1");
  process.exit(2);
}

const cases = loadCases();
console.log(`Gate for release ${releaseName}: ${cases.length} cases, dry runs, no letters sent.`);
const caseIds = cases.map((evalCase) => evalCase.application_id);
const decisions = runCases(releaseName, caseIds);
let failedCount = 0;
for (const evalCase of cases) {
  const problems = problemsFor(evalCase, decisions);
  if (problems.length > 0) failedCount++;
  if (problems.length === 0) console.log(`  PASS  ${evalCase.application_id}`);
  else console.log(`  FAIL  ${evalCase.application_id}  ${problems.join("; ")}`);
}
const passedCount = cases.length - failedCount;
console.log(`Release ${releaseName}: ${passedCount} of ${cases.length} cases pass.`);

// A release that fails any case is blocked: the exit code 1 stops any script that ships it.
if (failedCount > 0) {
  console.log(`Release ${releaseName} is blocked.`);
  process.exit(1);
}
console.log(`Release ${releaseName} may ship.`);
process.exit(0);

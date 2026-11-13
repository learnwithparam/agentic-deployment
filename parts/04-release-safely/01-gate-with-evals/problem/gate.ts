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

// The world made the desk's gateway key, in the secrets folder at the top of the repo.
const SECRETS = process.env.HDC_SECRETS ?? join(HERE, "..", "..", "..", "..", "secrets");

// Build this folder's image, so the gate tests the code you ship. Prints the image id.
function buildImage(): string {
  const built = Bun.spawnSync(["docker", "build", "-q", HERE], { stderr: "pipe" });
  if (built.exitCode !== 0) {
    throw new Error(`The desk image did not build:\n${built.stderr.toString().trim()}`);
  }
  return built.stdout.toString().trim();
}

// Start the runner in a fresh container on the world's network, with only the gateway key.
function runCases(releaseName: string, applicationIds: string[]): Decision[] {
  const keyFile = join(SECRETS, "desk_gateway_key");
  const settings = [
    ...["-e", "DRY_RUN=1", "-e", "DESK_DATA=/tmp/evals", "-e", "SERVICE_VERSION=gate"],
    ...["-e", `RELEASE_FILE=/app/releases/${releaseName}.json`],
    ...["-v", `${keyFile}:/run/secrets/gateway_key:ro`],
  ];
  const runner = [buildImage(), "bun", "src/evals.ts", ...applicationIds];
  const command = ["docker", "run", "--rm", "--network", "hdc", ...settings, ...runner];
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

// TODO(you): block a release that fails. Exit with code 1 when any case fails, so a script
// that ships releases stops here. Today the gate always says yes.
process.exit(0);

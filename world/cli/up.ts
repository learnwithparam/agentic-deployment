// bun run up finished              start the world and the finished permit desk on :8080
// bun run up <step-name>           start the world and your desk from that step's problem/ on :3000
// bun run up <step-name> solution  the same, from the sample solution
import { existsSync } from "node:fs";
import { join } from "node:path";
import { allSteps, findStep } from "../../scripts/structure";
import { type CommandResult, composeEnv, healthy, runCommand, startWorld, URLS } from "./lib";

function lastLines(result: CommandResult, howMany: number): string {
  const printed = (result.err || result.out).trim();
  return printed.split("\n").slice(-howMany).join("\n");
}

async function startFinished() {
  console.log(
    "Starting the finished permit desk: stable and canary desks, Traefik, Prometheus, " +
      "Alertmanager, release controller.",
  );
  const composeUp = [
    ...["docker", "compose", "-f", "world/finished/compose.yaml", "up"],
    ...["-d", "--build", "--wait", "--wait-timeout", "180"],
  ];
  const result = await runCommand(composeUp, { env: composeEnv() });
  if (result.code !== 0) {
    throw new Error(`The finished desk did not start:\n${lastLines(result, 6)}`);
  }
  if (!(await healthy(`${URLS.finished}/healthz`, 20))) {
    throw new Error("The finished desk started but http://localhost:8080/healthz does not answer.");
  }
  console.log(`The finished permit desk is running on ${URLS.finished}`);
  console.log(`  Resident page  ${URLS.finished}`);
  console.log(`  Staff queue    ${URLS.finished}/staff`);
  console.log(`  Trace desk     ${URLS.traces}`);
  console.log(`  Register       ${URLS.register}`);
  console.log(`  Prometheus     ${URLS.prometheus}/alerts`);
}

function stepFolder(stepName: string, version: string | undefined): string {
  const step = findStep(stepName);
  if (!step) {
    const stepNames = allSteps().map((known) => known.name);
    throw new Error(`There is no step called "${stepName}". Steps: ${stepNames.join(", ")}`);
  }
  const folder = join(step.dir, version === "solution" ? "solution" : "problem");
  if (!existsSync(join(folder, "compose.yaml"))) {
    throw new Error(`${folder} has no compose.yaml yet.`);
  }
  return folder;
}

async function startDesk(stepName: string, version: string | undefined) {
  const folder = stepFolder(stepName, version);
  const compose = ["docker", "compose", "-p", "hdc-desk", "-f", join(folder, "compose.yaml")];
  const options = { env: composeEnv(), cwd: folder };
  const services = await runCommand([...compose, "config", "--services"], options);
  if (!services.out.split("\n").includes("desk")) {
    throw new Error(
      `compose.yaml in ${folder} has no service named "desk" yet. ` +
        "Adding it is part of package-the-agent.",
    );
  }
  const upFlags = ["up", "-d", "--build", "--wait", "--wait-timeout", "90"];
  const result = await runCommand([...compose, ...upFlags], options);
  if (result.code !== 0) {
    const readLogs = "Read its logs: docker compose -p hdc-desk logs desk";
    throw new Error(`Your desk did not start:\n${lastLines(result, 6)}\n${readLogs}`);
  }
  const whose = version === "solution" ? "sample solution" : "your work";
  console.log(`Your permit desk (${stepName}, ${whose}) is running on ${URLS.desk}`);
}

const [what, version] = process.argv.slice(2);
try {
  if (!what) throw new Error("Name what to start: bun run up finished, or bun run up <step-name>.");
  await startWorld();
  if (what === "finished") await startFinished();
  else await startDesk(what, version);
} catch (error) {
  console.log((error as Error).message);
  process.exit(2);
}

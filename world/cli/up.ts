// bun run up finished              start the world and the finished permit desk on http://localhost:8080
// bun run up <step-name>           start the world and your desk from that step's problem/ folder on :3000
// bun run up <step-name> solution  the same, from the sample solution
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, URLS, sh, composeEnv, startWorld, healthy } from "./lib";
import { findStep, allSteps } from "../../scripts/structure";

const [what, which] = process.argv.slice(2);
try {
  if (!what) throw new Error("Name what to start: bun run up finished, or bun run up <step-name>.");
  await startWorld();
  if (what === "finished") {
    console.log("Starting the finished permit desk: stable and canary desks, Traefik, Prometheus, Alertmanager, release controller.");
    const r = await sh(["docker", "compose", "-f", "world/finished/compose.yaml", "up", "-d", "--build", "--wait", "--wait-timeout", "180"], { env: composeEnv() });
    if (r.code !== 0) throw new Error(`The finished desk did not start:\n${(r.err || r.out).trim().split("\n").slice(-6).join("\n")}`);
    if (!(await healthy(`${URLS.finished}/healthz`, 20))) throw new Error("The finished desk started but http://localhost:8080/healthz does not answer.");
    console.log(`The finished permit desk is running on ${URLS.finished}`);
    console.log(`  Resident page  ${URLS.finished}`);
    console.log(`  Staff queue    ${URLS.finished}/staff`);
    console.log(`  Trace desk     ${URLS.traces}`);
    console.log(`  Register       ${URLS.register}`);
    console.log(`  Prometheus     ${URLS.prometheus}/alerts`);
  } else {
    const step = findStep(what);
    if (!step) throw new Error(`There is no step called "${what}". Steps: ${allSteps().map((s) => s.name).join(", ")}`);
    const dir = join(step.dir, which === "solution" ? "solution" : "problem");
    if (!existsSync(join(dir, "compose.yaml"))) throw new Error(`${dir} has no compose.yaml yet.`);
    const services = await sh(["docker", "compose", "-p", "hdc-desk", "-f", join(dir, "compose.yaml"), "config", "--services"], { env: composeEnv(), cwd: dir });
    if (!services.out.split("\n").includes("desk")) throw new Error(`compose.yaml in ${dir} has no service named "desk" yet. Adding it is part of package-the-agent.`);
    const r = await sh(["docker", "compose", "-p", "hdc-desk", "-f", join(dir, "compose.yaml"), "up", "-d", "--build", "--wait", "--wait-timeout", "90"], { env: composeEnv(), cwd: dir });
    if (r.code !== 0) throw new Error(`Your desk did not start:\n${(r.err || r.out).trim().split("\n").slice(-6).join("\n")}\nRead its logs: docker compose -p hdc-desk logs desk`);
    console.log(`Your permit desk (${what}, ${which === "solution" ? "sample solution" : "your work"}) is running on ${URLS.desk}`);
  }
} catch (e) {
  console.log((e as Error).message);
  process.exit(2);
}
void ROOT;

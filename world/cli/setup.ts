// biome-ignore-all lint/style/useNamingConvention: Docker's info JSON names memory MemTotal
// bun run setup: check this machine can run the course, and say what to do when it cannot.

import { existsSync } from "node:fs";
import { type CommandResult, runCommand } from "./lib";

const PORTS = [3000, 7001, 7002, 7003, 7004, 7010, 8080, 9090, 9093];
let thingsToFix = 0;

function report(good: boolean, whenGood: string, whenBad: string) {
  console.log(good ? `  ok    ${whenGood}` : `  FIX   ${whenBad}`);
  if (!good) thingsToFix++;
}

function checkDockerMemory(docker: CommandResult) {
  const info = JSON.parse(docker.out) as { MemTotal?: number };
  const gigabytes = Number(info.MemTotal ?? 0) / 1024 ** 3;
  report(
    gigabytes >= 4,
    `Docker can use ${gigabytes.toFixed(1)} GB of memory`,
    `Docker can use only ${gigabytes.toFixed(1)} GB. ` +
      "Give it at least 4 GB in Docker Desktop, Settings, Resources.",
  );
}

async function checkCompose() {
  const compose = await runCommand(["docker", "compose", "version", "--short"]);
  const version = compose.out.trim();
  const [major, minor] = version.split(".").map(Number);
  const newEnough = major > 2 || (major === 2 && minor >= 24);
  report(
    compose.code === 0 && newEnough,
    `Docker Compose ${version}`,
    "Docker Compose 2.24 or newer is needed. Update Docker Desktop.",
  );
}

async function checkDocker() {
  const notRunning: CommandResult = { code: 1, out: "", err: "" };
  const dockerInfo = ["docker", "info", "--format", "{{json .}}"];
  const docker = await runCommand(dockerInfo).catch(() => notRunning);
  report(
    docker.code === 0,
    "Docker is running",
    "Docker is not running. Start Docker Desktop (or the Docker service) " +
      "and run bun run setup again.",
  );
  if (docker.code !== 0) return;
  checkDockerMemory(docker);
  await checkCompose();
}

function busyPorts(): number[] {
  const busy: number[] = [];
  for (const port of PORTS) {
    try {
      const listener = Bun.listen({
        hostname: "0.0.0.0",
        port,
        socket: {
          data() {
            // Only checking the port is free; nothing is ever sent here.
          },
        },
      });
      listener.stop(true);
    } catch {
      busy.push(port);
    }
  }
  return busy;
}

async function checkPorts() {
  const busy = busyPorts();
  // A port held by the course's own containers is fine: the world is already running.
  const containers = await runCommand(["docker", "ps", "--format", "{{.Names}}"]);
  const containerNames = containers.out.split("\n");
  const oursRunning = containerNames.some((name) => name.startsWith("hdc-"));
  report(
    busy.length === 0 || oursRunning,
    "ports 3000, 7001 to 7004, 7010, 8080, 9090 and 9093 are free",
    `ports ${busy.join(", ")} are in use by another program. ` +
      "Stop it, or change the port in the compose files.",
  );
}

await checkDocker();
await checkPorts();
const envNote = existsSync(".env")
  ? ".env found; the provider comes from LLM_PROVIDER"
  : "no .env, so the model provider is replay (no key needed)";
report(true, envNote, "");
if (thingsToFix) console.log(`${thingsToFix} thing(s) to fix before you start.`);
else console.log("This machine is ready. Next: bun run world");
process.exit(thingsToFix ? 1 : 0);

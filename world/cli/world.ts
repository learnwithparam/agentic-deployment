// bun run world          start the world and seed it (safe to run again)
// bun run world reset    put every application back to "received"; clear letters, spend and spans
// bun run world status   say what is running and what the register holds
// bun run world stop     stop the world (data is kept)
import {
  composeEnv,
  gatewayProvider,
  resetWorld,
  runCommand,
  startWorld,
  URLS,
  worldUp,
} from "./lib";

async function showStatus() {
  const response = await fetch(`${URLS.register}/applications`);
  const applications = (await response.json()) as { status: string }[];
  const count = (status: string) =>
    applications.filter((application) => application.status === status).length;
  console.log(`The world is running. Model provider: ${await gatewayProvider()}.`);
  const counts = [
    `${count("received")} received`,
    `${count("invalid_missing_items")} invalid`,
    `${count("valid_awaiting_officer")} awaiting an officer`,
    `${count("validated")} validated`,
  ];
  const summary = `${applications.length} applications: ${counts.join(", ")}`;
  console.log(`  Register     ${URLS.register}   ${summary}`);
  console.log(`  Gateway      ${URLS.gateway}`);
  console.log(`  Sign-in      ${URLS.idp}`);
  console.log(`  Trace desk   ${URLS.traces}`);
}

async function start() {
  await startWorld();
  await showStatus();
}

async function reset() {
  await startWorld(() => {
    // Quiet: the reset message below is all the learner needs.
  });
  await resetWorld();
  console.log("The world is reset: 40 applications received, no letters, no spend, no spans.");
}

async function status() {
  if (!(await worldUp())) {
    console.log("The world is not running. Start it with: bun run world");
    process.exit(1);
  }
  await showStatus();
}

async function stop() {
  const composeStop = ["docker", "compose", "-f", "world/compose.yaml", "stop"];
  await runCommand(composeStop, { env: composeEnv() });
  console.log("The world is stopped. Its data is kept. Start it again with: bun run world");
}

const COMMANDS: Record<string, () => Promise<void>> = { start, reset, status, stop };

const command = process.argv[2] ?? "start";
try {
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run) {
    const usage =
      "bun run world, bun run world reset, bun run world status, bun run world stop";
    console.log(`Unknown command "${command}". Use: ${usage}`);
    process.exit(1);
  }
  await run();
} catch (error) {
  console.log((error as Error).message);
  process.exit(2);
}

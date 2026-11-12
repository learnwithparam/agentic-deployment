// bun run world          start the world and seed it (safe to run again)
// bun run world reset    put every application back to "received" and clear letters, spend and spans
// bun run world status   say what is running and what the register holds
// bun run world stop     stop the world (data is kept)
import { URLS, startWorld, resetWorld, worldUp, gatewayProvider, sh, composeEnv } from "./lib";

const cmd = process.argv[2] ?? "start";
try {
  if (cmd === "start") {
    await startWorld();
    await status();
  } else if (cmd === "reset") {
    await startWorld(() => {});
    await resetWorld();
    console.log("The world is reset: 40 applications received, no letters, no spend, no spans.");
  } else if (cmd === "status") {
    if (!(await worldUp())) { console.log("The world is not running. Start it with: bun run world"); process.exit(1); }
    await status();
  } else if (cmd === "stop") {
    await sh(["docker", "compose", "-f", "world/compose.yaml", "stop"], { env: composeEnv() });
    console.log("The world is stopped. Its data is kept. Start it again with: bun run world");
  } else {
    console.log(`Unknown command "${cmd}". Use: bun run world, bun run world reset, bun run world status, bun run world stop`);
    process.exit(1);
  }
} catch (e) {
  console.log((e as Error).message);
  process.exit(2);
}

async function status() {
  const apps = (await (await fetch(`${URLS.register}/applications`)).json()) as { status: string }[];
  const count = (s: string) => apps.filter((a) => a.status === s).length;
  console.log(`The world is running. Model provider: ${await gatewayProvider()}.`);
  console.log(`  Register     ${URLS.register}   ${apps.length} applications: ${count("received")} received, ${count("invalid_missing_items")} invalid, ${count("valid_awaiting_officer")} awaiting an officer, ${count("validated")} validated`);
  console.log(`  Gateway      ${URLS.gateway}`);
  console.log(`  Sign-in      ${URLS.idp}`);
  console.log(`  Trace desk   ${URLS.traces}`);
}

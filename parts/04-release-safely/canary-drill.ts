// bun run drill <release>: put a release on a 10% canary of the desk on :3000, send residents'
// runs, and report what the release controller did. Nobody touches the keyboard.
//   bun run drill v2    the bad release: it should be rolled back within 3 minutes
//   bun run drill v3    the good release: it should still be at 10% after 30 seconds
// It uses the replay model, so it costs nothing.
import { gatewayProvider, healthy } from "../../world/cli/lib";
import { CONTROLLER, canaryDrill, setDeskBudget } from "./release-stack";

const release = process.argv[2];
if (!release) {
  console.log("Name a release: bun run drill v2, or bun run drill v3");
  process.exit(2);
}
if (!(await healthy(`${CONTROLLER}/health`))) {
  console.log(
    "No release controller answers on :7010. Start the stack: docker compose up -d --wait",
  );
  process.exit(2);
}
if ((await gatewayProvider()) !== "replay") {
  console.log("The drill runs only with LLM_PROVIDER=replay, so it never spends real money.");
  process.exit(2);
}
await setDeskBudget(10);
// A bad release gets 3 minutes to be caught. A good one is watched for 30 seconds.
const seconds = release === "v3" ? 30 : 180;
const drill = await canaryDrill(release, seconds, console.log);
await setDeskBudget(2);
const took = `${drill.seconds.toFixed(0)} s`;
if (drill.rollback) {
  console.log(`Alert ${drill.rollback.alert} fired for release ${drill.rollback.release}.`);
  console.log(
    `Rolled back to 0% after ${took} and ${drill.runs} runs, with no one at the keyboard.`,
  );
} else {
  console.log(`No rollback after ${took} and ${drill.runs} runs. Canary at ${drill.weightAtEnd}%.`);
}

// bun run down        stop your desk and the finished desk (the world keeps running)
// bun run down all    stop everything, the world too. Data is kept; `bun run world reset` clears it.
import { composeEnv, runCommand } from "./lib";

const everything = process.argv[2] === "all";
const options = { env: composeEnv() };
await runCommand(["docker", "compose", "-p", "hdc-desk", "down", "--remove-orphans"], options);
const finishedDown = ["down", "--remove-orphans"];
await runCommand(["docker", "compose", "-f", "world/finished/compose.yaml", ...finishedDown], options);
if (everything) {
  await runCommand(["docker", "compose", "-f", "world/compose.yaml", "down"], options);
  console.log("Everything is stopped. Start again with: bun run world");
} else {
  console.log("The desks are stopped. The world is still running.");
}

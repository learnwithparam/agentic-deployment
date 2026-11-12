// bun run down        stop your desk and the finished desk (the world keeps running)
// bun run down all    stop everything, the world too. Data is kept; `bun run world reset` clears it.
import { composeEnv, sh } from "./lib";

const all = process.argv[2] === "all";
await sh(["docker", "compose", "-p", "hdc-desk", "down", "--remove-orphans"], {
  env: composeEnv(),
});
await sh(["docker", "compose", "-f", "world/finished/compose.yaml", "down", "--remove-orphans"], {
  env: composeEnv(),
});
if (all) await sh(["docker", "compose", "-f", "world/compose.yaml", "down"], { env: composeEnv() });
console.log(
  all
    ? "Everything is stopped. Start again with: bun run world"
    : "The desks are stopped. The world is still running.",
);

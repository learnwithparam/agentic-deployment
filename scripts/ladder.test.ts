// Proves the ladder check bites: it must fail the bad fixtures and pass the good one.
import { expect, test } from "bun:test";
import { join } from "node:path";

// The fixtures use fake links, so liveness must stay off here.
const withoutLinks = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "LINKS"),
);

const run = (name: string) =>
  Bun.spawnSync(
    ["bun", join(import.meta.dir, "ladder.ts"), "--root", join("scripts/fixtures/ladder", name)],
    {
      cwd: join(import.meta.dir, ".."),
      env: withoutLinks,
    },
  );

test("fails a ladder with a feature that has no step", () => {
  expect(run("fail-missing-feature").exitCode).toBe(1);
});
test("passes a full ladder", () => {
  expect(run("pass").exitCode).toBe(0);
});

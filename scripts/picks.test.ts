// Proves the picks check bites: it must fail the bad fixtures and pass the good one.
import { expect, test } from "bun:test";
import { join } from "node:path";

// The fixtures use fake links, so liveness must stay off here.
const withoutLinks = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "LINKS"),
);

const run = (name: string) =>
  Bun.spawnSync(
    ["bun", join(import.meta.dir, "picks.ts"), "--root", join("scripts/fixtures/picks", name)],
    {
      cwd: join(import.meta.dir, ".."),
      env: withoutLinks,
    },
  );

test("fails a part with three picks", () => {
  expect(run("fail-three-picks").exitCode).toBe(1);
});
test("fails a denylisted host", () => {
  expect(run("fail-denylisted-host").exitCode).toBe(1);
});
test("passes a part with five picks and two videos", () => {
  expect(run("pass").exitCode).toBe(0);
});

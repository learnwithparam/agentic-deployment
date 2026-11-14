// Proves the date rule bites: the bad page fails with the exact count, the good page passes.
import { expect, test } from "bun:test";
import { join } from "node:path";

const CHECK = join(import.meta.dir, "plain-english.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "dates");

function runOn(page: string) {
  const run = Bun.spawnSync(["bun", CHECK, join(FIXTURES, page)]);
  return { code: run.exitCode, errors: run.stderr.toString() };
}

test("bad page fails with four date problems", () => {
  const { code, errors } = runOn("bad.md");
  expect(code).toBe(1);
  expect(errors).toContain("4 plain-English problems");
  expect(errors.match(/date in prose: say what it is, not when/g)?.length).toBe(4);
});

test("good page passes", () => {
  const { code, errors } = runOn("good.md");
  expect(errors).toBe("");
  expect(code).toBe(0);
});

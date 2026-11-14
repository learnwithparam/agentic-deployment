// Proves the prose rules bite: the bad page fails with the exact count, the good page passes.
import { expect, test } from "bun:test";
import { join } from "node:path";

const CHECK = join(import.meta.dir, "plain-english.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "prose");

function runOn(page: string) {
  const run = Bun.spawnSync(["bun", CHECK, join(FIXTURES, page)]);
  return { code: run.exitCode, errors: run.stderr.toString() };
}

test("bad page fails with one problem of each kind", () => {
  const { code, errors } = runOn("bad.md");
  expect(code).toBe(1);
  expect(errors).toContain("3 plain-English problems");
  expect(errors).toContain("backticked English");
  expect(errors).toContain("exact minutes");
  expect(errors).toContain("version number");
});

test("good page passes", () => {
  const { code, errors } = runOn("good.md");
  expect(errors).toBe("");
  expect(code).toBe(0);
});

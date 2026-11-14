import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workFiles } from "./workfiles";

test("a build note at the root is found, a README is not", () => {
  const root = mkdtempSync(join(tmpdir(), "work-"));
  writeFileSync(join(root, "README.md"), "x");
  writeFileSync(join(root, "picks.denylist.json"), "{}");
  expect(workFiles(root)).toEqual([]);
  writeFileSync(join(root, "PICKS-CANDIDATES.md"), "x");
  expect(workFiles(root)).toEqual(["PICKS-CANDIDATES.md"]);
});

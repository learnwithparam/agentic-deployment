// Proves the shape checks bite: each fixture pair fails first, then passes.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capstoneProblems } from "./capstone";
import { exampleFilesProblems, partShapeProblems, stepShapeProblems } from "./structure";

const fixtures = join(import.meta.dir, "fixtures", "shape");
const page = (folder: string) => readFileSync(join(fixtures, folder, "README.md"), "utf8");
const exampleFiles = (folder: string) =>
  (
    Bun.TOML.parse(readFileSync(join(fixtures, folder, "step.toml"), "utf8")) as {
      // biome-ignore lint/style/useNamingConvention: this is the field name written in step.toml
      example_files: string[];
    }
  ).example_files;

test("a long problem and a missing Do it on your work fail a step", () => {
  const problems = stepShapeProblems(page("bad-step")).join("\n");
  expect(problems).toContain("Do it on your work");
  expect(problems).toContain("keep it to 60 or fewer");
});

test("a well shaped step passes", () => {
  expect(stepShapeProblems(page("good-step"))).toEqual([]);
});

test("a step with three example files fails, one file passes", () => {
  expect(exampleFilesProblems(exampleFiles("bad-step"))[0]).toContain("more than two world files");
  expect(exampleFilesProblems(exampleFiles("good-step"))).toEqual([]);
});

test("a part with missing sections and no steps table fails", () => {
  const problems = partShapeProblems(page("bad-part")).join("\n");
  expect(problems).toContain("After this part you can");
  expect(problems).toContain("steps table");
});

test("a well shaped part passes", () => {
  expect(partShapeProblems(page("good-part"))).toEqual([]);
});

test("the capstone fixture fails on its template and passes on its sample", () => {
  expect(capstoneProblems(join(fixtures, "capstone"))).toEqual([]);
});

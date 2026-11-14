// Reads the repo layout once. Every other script asks this file where things are.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

export type Step = {
  name: string; // verb-the-thing, also the command argument
  dir: string;
  part: string;
  meta: { minutes: number; screen: boolean; solution: boolean; exampleFiles: string[] };
};
export type Part = { name: string; dir: string; steps: Step[] };

type StepSettings = {
  minutes?: number;
  screen?: boolean;
  solution?: boolean;
  // biome-ignore lint/style/useNamingConvention: this is the field name written in step.toml
  example_files?: string[];
};

function subfolders(folder: string): string[] {
  if (!existsSync(folder)) return [];
  const entries = readdirSync(folder);
  const folders = entries.filter((entry) => statSync(join(folder, entry)).isDirectory());
  return folders.sort();
}

// Folders keep an order prefix for sorting only. Learners never type it.
export const bareName = (folder: string) => folder.replace(/^\d+-/, "");

function readSettings(stepFolder: string): StepSettings {
  const settingsPath = join(stepFolder, "step.toml");
  if (!existsSync(settingsPath)) return {};
  return Bun.TOML.parse(readFileSync(settingsPath, "utf8")) as StepSettings;
}

function loadStep(partFolder: string, partName: string, stepName: string): Step {
  const stepFolder = join(partFolder, stepName);
  const settings = readSettings(stepFolder);
  return {
    name: bareName(stepName),
    dir: stepFolder,
    part: bareName(partName),
    meta: {
      minutes: Number(settings.minutes ?? 0),
      screen: Boolean(settings.screen),
      solution: Boolean(settings.solution),
      exampleFiles: settings.example_files ?? [],
    },
  };
}

// The root argument lets fixture repos be read the same way as the real one.
export function parts(root: string = ROOT): Part[] {
  const partsFolder = join(root, "parts");
  return subfolders(partsFolder).map((partName) => {
    const partFolder = join(partsFolder, partName);
    const steps = subfolders(partFolder).map((stepName) =>
      loadStep(partFolder, partName, stepName),
    );
    return { name: bareName(partName), dir: partFolder, steps };
  });
}

export const allSteps = (root: string = ROOT) => parts(root).flatMap((part) => part.steps);

export function findStep(name: string, root: string = ROOT): Step | undefined {
  return allSteps(root).find((step) => step.name === name);
}

// Shape rules (standard sections 1 to 3). Pure functions, so the fixtures can test them.
export const STEP_SECTIONS = [
  "The problem",
  "Watch it done",
  "Your turn",
  "Do it on your work",
  "Done when",
  "Solution",
];
export const PART_SECTIONS = [
  "After this part you can",
  "You leave with",
  "The problem",
  "Watch and read",
  "Project",
];
export const MAX_PROBLEM_WORDS = 60;
export const MAX_EXAMPLE_FILES = 2;
export const EXAMPLE_TOO_BIG =
  "the example needs more than two world files: shrink it or move the rest to Go further";

const headingLine = (name: string) => new RegExp(`^## ${name}[ \\t]*$`, "m");

function sectionBody(text: string, name: string): string | undefined {
  const start = text.search(headingLine(name));
  if (start < 0) return undefined;
  const fromHeading = text.slice(start);
  const body = fromHeading.slice(fromHeading.indexOf("\n") + 1);
  return body.split(/^## /m)[0];
}

// Code does not count: a learner reads the sentences, and the how can have long commands.
export function wordsOutsideCode(text: string): number {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  return prose.split(/\s+/).filter(Boolean).length;
}

function sectionsInOrder(text: string, names: string[]): string[] {
  const problems: string[] = [];
  let lastPosition = -1;
  for (const name of names) {
    const position = text.search(headingLine(name));
    if (position < 0) problems.push(`missing section "## ${name}"`);
    else if (position < lastPosition) problems.push(`section "## ${name}" is out of order`);
    else lastPosition = position;
  }
  return problems;
}

export function stepShapeProblems(text: string): string[] {
  const problems = sectionsInOrder(text, STEP_SECTIONS);
  const problem = sectionBody(text, "The problem");
  if (problem !== undefined && wordsOutsideCode(problem) > MAX_PROBLEM_WORDS) {
    const count = wordsOutsideCode(problem);
    problems.push(
      `the problem section has ${count} words; keep it to ${MAX_PROBLEM_WORDS} or fewer`,
    );
  }
  return problems;
}

export function partShapeProblems(text: string): string[] {
  const problems = sectionsInOrder(text, PART_SECTIONS);
  if (!/^\|\s*Step\s*\|.*\n\|[\s:|-]+\|/im.test(text)) {
    problems.push(`missing the steps table: a table whose first column is "Step"`);
  }
  return problems;
}

export function exampleFilesProblems(files: string[]): string[] {
  return files.length > MAX_EXAMPLE_FILES ? [EXAMPLE_TOO_BIG] : [];
}

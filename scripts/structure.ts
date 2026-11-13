// Reads the repo layout once. Every other script asks this file where things are.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

export type Step = {
  name: string; // verb-the-thing, also the command argument
  dir: string;
  part: string;
  meta: { minutes: number; screen: boolean; solution: boolean };
};
export type Part = { name: string; dir: string; steps: Step[] };

// What a step.toml may hold; every field is optional.
type StepToml = { minutes?: number; screen?: boolean; solution?: boolean };

function folderNames(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const entries = readdirSync(path);
  const folders = entries.filter((entry) => statSync(join(path, entry)).isDirectory());
  return folders.sort();
}

// Folders keep an order prefix for sorting only. Learners never type it.
export const bareName = (folder: string) => folder.replace(/^\d+-/, "");

function readStep(partFolder: string, stepFolder: string, partName: string): Step {
  const stepDir = join(partFolder, stepFolder);
  const metaPath = join(stepDir, "step.toml");
  let settings: StepToml = {};
  if (existsSync(metaPath)) {
    settings = Bun.TOML.parse(readFileSync(metaPath, "utf8")) as StepToml;
  }
  return {
    name: bareName(stepFolder),
    dir: stepDir,
    part: partName,
    meta: {
      minutes: Number(settings.minutes ?? 0),
      screen: Boolean(settings.screen),
      solution: Boolean(settings.solution),
    },
  };
}

// The orientation is the first part when it holds a step (a folder with step.toml).
export function parts(): Part[] {
  const root = join(ROOT, "parts");
  const orientation = join(ROOT, "00-orientation");
  const isStepFolder = (folder: string, name: string) =>
    existsSync(join(folder, name, "step.toml"));
  const folders: { dir: string; name: string }[] = [];
  if (folderNames(orientation).some((name) => isStepFolder(orientation, name))) {
    folders.push({ dir: orientation, name: "orientation" });
  }
  for (const partFolder of folderNames(root)) {
    folders.push({ dir: join(root, partFolder), name: bareName(partFolder) });
  }
  return folders.map(({ dir, name }) => {
    const stepFolders = folderNames(dir).filter(
      (stepFolder) => dir !== orientation || isStepFolder(dir, stepFolder),
    );
    const steps = stepFolders.map((stepFolder) => readStep(dir, stepFolder, name));
    return { name, dir, steps };
  });
}

export const allSteps = () => parts().flatMap((part) => part.steps);

export function findStep(name: string): Step | undefined {
  return allSteps().find((step) => step.name === name);
}

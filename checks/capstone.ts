// Shared helper for a course's capstone/check.ts. It takes the learner's artefact folder as its
// one argument, so the same check runs on the empty template and on the filled sample.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CapstoneRule = {
  says: string;
  test: (artefact: string) => boolean;
  tryNext: string;
};

export const readArtefact = (folder: string, file: string) => {
  const path = join(folder, file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

export function runCapstoneCheck(rules: CapstoneRule[]): never {
  const artefact = process.argv[2];
  if (!artefact) {
    console.error(
      "Give the folder with your capstone work, for example: bun capstone/check.ts my-work",
    );
    process.exit(2);
  }
  const failed = rules.filter((rule) => !rule.test(artefact));
  for (const rule of failed) console.log(`FAIL ${rule.says}\n  Try next: ${rule.tryNext}`);
  if (failed.length === 0) console.log(`Done. All ${rules.length} capstone rules pass.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

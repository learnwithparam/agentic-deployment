// Learners see this repo. Build notes never ship: this fails a PR that still has one.
import { readdirSync } from "node:fs";

const WORK = /PICKS|CANDIDATES|REVIEW|NOTES|PLAN|BRIEF|PACKET|TODO/i;

function isBuildNote(name: string): boolean {
  const isMarkdown = name.endsWith(".md");
  const isReadme = /^README/i.test(name);
  return isMarkdown && !isReadme && WORK.test(name);
}

export function workFiles(root: string): string[] {
  return readdirSync(root).filter(isBuildNote);
}

if (import.meta.main) {
  const found = workFiles(process.argv[2] ?? ".");
  for (const name of found) console.error(`${name}: a build note at the root, delete it`);
  process.exit(found.length === 0 ? 0 : 1);
}

// bun run check: the repo standard. CI runs this; any failure stops the build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  allSteps,
  exampleFilesProblems,
  type Part,
  partShapeProblems,
  parts,
  ROOT,
  type Step,
  stepShapeProblems,
} from "./structure";

const problems: string[] = [];

function report(where: string, what: string) {
  problems.push(`${relative(ROOT, where) || "."}: ${what}`);
}

const readText = (path: string) => readFileSync(path, "utf8");

const HYPE_PHRASES = [
  "supercharge|unleash|unlock|seamless(ly)?|leverage|dive into|game[- ]changer",
  "revolutioni[sz]e|magic(al)?|cutting[- ]edge|AI-powered",
].join("|");
const HYPE_WORDS = new RegExp(`\\b(${HYPE_PHRASES})\\b`, "i");
const TIME_WORDS = /\b(week|day|hour)\s+\d+\b/i;
const VERB_THING = /^[a-z]+(-[a-z0-9]+)+$/;
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const MERMAID = /```mermaid\n/;
const MODEL_NAME = /\b(claude-[a-z0-9-]+-\d|gpt-\d[\w.-]*|gemini-\d[\w.-]*|o\d-(mini|pro)\b)/i;

const hasImage = (text: string) => [...text.matchAll(IMAGE)].length > 0;

function listFiles(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder)) {
    // Fixtures are pages that fail on purpose, so the shape tests can prove the checks bite.
    if (entry === "node_modules" || entry === ".git" || entry === "fixtures") continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) listFiles(path, found);
    else found.push(path);
  }
  return found;
}

const allFiles = listFiles(ROOT);
const markdownFiles = allFiles.filter((file) => file.endsWith(".md"));

// 1. No Makefile anywhere.
function checkNoMakefile() {
  for (const file of allFiles) {
    if (/(^|\/)(GNU)?[Mm]akefile$/.test(file)) {
      report(file, "a Makefile is not allowed; use a Bun or uv script");
    }
  }
}

// 2. Prose rules on every Markdown file.
function checkProseLine(file: string, line: string, lineNumber: number) {
  if (line.includes("—")) report(file, `line ${lineNumber}: em dash`);
  const hype = line.match(HYPE_WORDS);
  if (hype) report(file, `line ${lineNumber}: hype word "${hype[0]}"`);
  const timeWord = line.match(TIME_WORDS);
  if (timeWord && !file.includes("schedules")) {
    report(file, `line ${lineNumber}: "${timeWord[0]}"; content is in parts, schedules map time`);
  }
  if (/\bM=\d+|verify \d+/.test(line)) {
    report(file, `line ${lineNumber}: numeric step command; name the step`);
  }
}

function checkProse() {
  for (const file of markdownFiles) {
    const lines = readText(file).split("\n");
    lines.forEach((line, index) => {
      checkProseLine(file, line, index + 1);
    });
  }
}

// 2b. Every page shows, not only tells: images it names exist, and the key pages carry a picture.
function checkImagesExist() {
  for (const file of markdownFiles) {
    for (const match of readText(file).matchAll(IMAGE)) {
      if (/^https?:/.test(match[1])) continue;
      if (!existsSync(join(dirname(file), match[1]))) {
        report(file, `image "${match[1]}" does not exist`);
      }
    }
  }
}

function checkPagePicture(file: string, what: string, needsMermaid: boolean, needsImage: boolean) {
  if (!existsSync(file)) return report(file, "missing");
  const text = readText(file);
  if (needsMermaid && !MERMAID.test(text)) report(file, `${what} needs a Mermaid diagram`);
  if (needsImage && !hasImage(text)) report(file, `${what} needs a screenshot`);
}

function checkKeyPagesHavePictures() {
  checkPagePicture(join(ROOT, "README.md"), "the root README", true, true);
  checkPagePicture(join(ROOT, "00-orientation", "README.md"), "the orientation", false, true);
}

// 3. Parts and steps.
function checkPartReadme(part: Part) {
  const readme = join(part.dir, "README.md");
  if (!existsSync(readme)) return report(part.dir, "part has no README.md");
  const text = readText(readme);
  if (!MERMAID.test(text)) report(readme, "part README needs a Mermaid diagram");
  for (const problem of partShapeProblems(text)) report(readme, problem);
}

function checkStepName(step: Step, namesSeen: Set<string>) {
  if (!VERB_THING.test(step.name)) {
    report(step.dir, `step name "${step.name}" must be verb-thing in lower case`);
  }
  if (namesSeen.has(step.name)) report(step.dir, `step name "${step.name}" is used twice`);
  namesSeen.add(step.name);
}

function checkStepFilesExist(step: Step) {
  if (!existsSync(join(step.dir, "step.toml"))) report(step.dir, "missing step.toml");
  if (step.meta.minutes < 5 || step.meta.minutes > 30) {
    report(
      step.dir,
      `step is ${step.meta.minutes} min; keep a step between 5 and 30, split it if longer`,
    );
  }
}

function checkStepReadme(step: Step, readme: string) {
  const text = readText(readme);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 600) {
    report(readme, `${wordCount} words; a step README stays under 600, split the step`);
  }
  for (const problem of stepShapeProblems(text)) report(readme, problem);
  if (!MERMAID.test(text) && !hasImage(text)) {
    report(readme, "a step shows a picture: a screenshot or a Mermaid diagram");
  }
  const doneSection = text.split("## Done when")[1]?.split("\n## ")[0] ?? "";
  if (!/^- /m.test(doneSection)) report(readme, "Done when needs at least one bullet");
  if (step.meta.screen) checkScreenStep(step, readme, text);
}

function checkScreenStep(step: Step, readme: string, readmeText: string) {
  const picture = join(step.dir, "images", "expected.png");
  if (!existsSync(picture)) report(step.dir, "screen step needs images/expected.png");
  if (!readmeText.includes("images/expected.png")) {
    report(readme, "screen step must show ../images/expected.png");
  }
}

function checkStepSolutionAndCheck(step: Step) {
  if (step.meta.solution && !existsSync(join(step.dir, "solution"))) {
    report(step.dir, "step.toml says solution but there is no solution/");
  }
  const hasTypeScriptCheck = existsSync(join(ROOT, "checks", `${step.name}.ts`));
  const hasPythonCheck = existsSync(join(ROOT, "checks", `${step.name}.py`));
  if (!hasTypeScriptCheck && !hasPythonCheck) {
    report(step.dir, `no check at checks/${step.name}.ts`);
  }
}

function checkStep(step: Step, namesSeen: Set<string>) {
  checkStepName(step, namesSeen);
  checkStepFilesExist(step);
  const readme = join(step.dir, "problem", "README.md");
  if (!existsSync(readme)) return report(step.dir, "missing problem/README.md");
  checkStepReadme(step, readme);
  for (const problem of exampleFilesProblems(step.meta.exampleFiles)) report(step.dir, problem);
  checkStepSolutionAndCheck(step);
}

function checkPartsAndSteps(allParts: Part[]) {
  const namesSeen = new Set<string>();
  if (allParts.length === 0) report(join(ROOT, "parts"), "no parts");
  for (const part of allParts) {
    checkPartReadme(part);
    if (part.steps.length === 0) report(part.dir, "part has no steps");
    for (const step of part.steps) checkStep(step, namesSeen);
  }
}

// 4. Commands: the README runs the finished system first, and every bash block says what to expect.
function checkRootReadmeOrder() {
  const rootReadme = join(ROOT, "README.md");
  if (!existsSync(rootReadme)) return report(ROOT, "missing README.md");
  const text = readText(rootReadme);
  const firstCode = text.indexOf("```bash");
  const firstConcept = text.search(/^## (How it works|Concepts|Background|Why)/m);
  if (firstCode < 0) {
    report(rootReadme, "the README needs a bash block that runs the finished system");
  } else if (firstConcept >= 0 && firstConcept < firstCode) {
    report(rootReadme, "run the finished system before any concept section");
  }
}

function checkBashBlocksSayWhatToExpect(file: string) {
  const lines = readText(file).split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "```bash") continue;
    let closing = index + 1;
    while (closing < lines.length && lines[closing].trim() !== "```") closing++;
    const lineAfter = lines.slice(closing + 1).find((line) => line.trim() !== "");
    if (!lineAfter?.startsWith("Expect:")) {
      report(file, `line ${index + 1}: a bash block must be followed by an Expect: line`);
    }
    index = closing;
  }
}

function checkCommands() {
  checkRootReadmeOrder();
  for (const file of markdownFiles) checkBashBlocksSayWhatToExpect(file);
}

// 5. One model config, exact pins, a troubleshooting table.
function checkModelsNamedInOnePlace() {
  const sourceFiles = allFiles.filter((file) => /\.(ts|py|md|json|toml|ya?ml)$/.test(file));
  for (const file of sourceFiles) {
    // This file holds the pattern that finds model names, so it would flag itself.
    if (file.includes("/config/models.") || file.includes("/scripts/check.ts")) continue;
    const found = readText(file).match(MODEL_NAME);
    if (found) {
      report(file, `model id "${found[0]}" outside config/models; name models in one place`);
    }
  }
}

function checkNodePackagesPinned() {
  const packageFile = join(ROOT, "package.json");
  if (!existsSync(packageFile)) return;
  const manifest = JSON.parse(readText(packageFile));
  const wanted: Record<string, string> = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, version] of Object.entries(wanted)) {
    if (!/^\d+\.\d+\.\d+$/.test(version))
      report(packageFile, `${name}@${version}: pin an exact version`);
  }
}

function checkPythonPackagesPinned() {
  const projectFile = join(ROOT, "pyproject.toml");
  if (!existsSync(projectFile)) return;
  const loosePin = /"([A-Za-z0-9_.\-[\]]+)\s*(>=|~=|\^|>|<)[^"]*"/g;
  for (const match of readText(projectFile).matchAll(loosePin)) {
    report(projectFile, `${match[1]}: pin with == not ${match[2]}`);
  }
}

function checkTroubleshootingTable() {
  const file = join(ROOT, "00-orientation", "troubleshooting.md");
  const tableHeader = /\| *What you see *\| *What it means *\| *Fix *\|/;
  if (!existsSync(file) || !tableHeader.test(readText(file))) {
    report(
      ROOT,
      "00-orientation/troubleshooting.md needs a table: What you see | What it means | Fix",
    );
  }
}

// 6. Every schedule covers every part, and the minutes add up.
type Schedule = Record<string, { sessions: { parts: string[]; minutes: number }[] }>;

function minutesPerPart(allParts: Part[]): Record<string, number> {
  const minutes: Record<string, number> = {};
  for (const part of allParts) {
    minutes[part.name] = part.steps.reduce((total, step) => total + step.meta.minutes, 0);
  }
  return minutes;
}

function checkScheduleCoversParts(
  schedulePath: string,
  format: string,
  listed: string[],
  allParts: Part[],
) {
  for (const part of allParts) {
    if (!listed.includes(part.name)) {
      report(schedulePath, `${format} leaves out part "${part.name}"`);
    }
  }
}

function checkSessionMinutes(
  schedulePath: string,
  format: string,
  sessions: Schedule[string]["sessions"],
  allParts: Part[],
) {
  const partMinutes = minutesPerPart(allParts);
  for (const session of sessions) {
    const needed = session.parts.reduce((total, name) => total + (partMinutes[name] ?? 0), 0);
    if (needed > session.minutes) {
      report(schedulePath, `${format}: a session needs ${needed} min but has ${session.minutes}`);
    }
  }
}

function checkSchedules(allParts: Part[]) {
  const schedulePath = join(ROOT, "schedules.toml");
  if (!existsSync(schedulePath)) return report(ROOT, "missing schedules.toml");
  const schedule = Bun.TOML.parse(readText(schedulePath)) as Schedule;
  for (const [format, definition] of Object.entries(schedule)) {
    const listed = definition.sessions.flatMap((session) => session.parts);
    checkScheduleCoversParts(schedulePath, format, listed, allParts);
    checkSessionMinutes(schedulePath, format, definition.sessions, allParts);
  }
}

function runEveryCheck() {
  const allParts = parts();
  checkNoMakefile();
  checkProse();
  checkImagesExist();
  checkKeyPagesHavePictures();
  checkPartsAndSteps(allParts);
  checkCommands();
  checkModelsNamedInOnePlace();
  checkNodePackagesPinned();
  checkPythonPackagesPinned();
  checkTroubleshootingTable();
  checkSchedules(allParts);
  return allParts;
}

const checkedParts = runEveryCheck();

if (problems.length > 0) {
  console.log(`The repo does not meet the standard. ${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `The repo meets the standard: ${checkedParts.length} part(s), ${allSteps().length} step(s).`,
);

// bun run check: the repo standard. CI runs this; any failure stops the build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { allSteps, type Part, parts, ROOT, type Step } from "./structure";

const errors: string[] = [];
const fail = (where: string, what: string) =>
  errors.push(`${relative(ROOT, where) || "."}: ${what}`);
const read = (path: string) => readFileSync(path, "utf8");

const STEP_SECTIONS = [
  "## The problem",
  "## Your challenge",
  "## Done when",
  "## If you get stuck",
  "## Words you will use",
];
const HYPE = new RegExp(
  "\\b(supercharge|unleash|unlock|seamless(ly)?|leverage|dive into|game[- ]changer|" +
    "revolutioni[sz]e|magic(al)?|cutting[- ]edge|AI-powered)\\b",
  "i",
);
const TIME_WORDS = /\b(week|day|hour)\s+\d+\b/i;
const VERB_THING = /^[a-z]+(-[a-z0-9]+)+$/;
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const MERMAID = /```mermaid\n/;
const MODEL_ID = /\b(claude-[a-z0-9-]+-\d|gpt-\d[\w.-]*|gemini-\d[\w.-]*|o\d-(mini|pro)\b)/i;
const TROUBLE_TABLE = /\| *What you see *\| *What it means *\| *Fix *\|/;

// Every file in the repo, skipping installed packages and git's own folder.
function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, found);
    } else {
      found.push(path);
    }
  }
  return found;
}

const hasImage = (text: string) => [...text.matchAll(IMAGE)].length > 0;

// The text between a heading and the next "## " heading, or undefined when the heading is missing.
function section(text: string, heading: string): string | undefined {
  const afterHeading = text.split(heading)[1];
  return afterHeading?.split("\n## ")[0];
}

// 1. No Makefile anywhere.
function checkNoMakefile(files: string[]) {
  for (const file of files) {
    if (/(^|\/)(GNU)?[Mm]akefile$/.test(file)) {
      fail(file, "a Makefile is not allowed; use a Bun or uv script");
    }
  }
}

// 2. Prose rules on every Markdown file.
function checkProseLine(file: string, line: string, lineNumber: number) {
  if (line.includes("—")) fail(file, `line ${lineNumber}: em dash`);
  const hype = line.match(HYPE);
  if (hype) fail(file, `line ${lineNumber}: hype word "${hype[0]}"`);
  const timeWord = line.match(TIME_WORDS);
  if (timeWord && !file.includes("schedules")) {
    fail(file, `line ${lineNumber}: "${timeWord[0]}"; content is in parts, schedules map time`);
  }
  if (/\bM=\d+|verify \d+/.test(line)) {
    fail(file, `line ${lineNumber}: numeric step command; name the step`);
  }
}

function checkProse(markdownFiles: string[]) {
  for (const file of markdownFiles) {
    const lines = read(file).split("\n");
    for (let i = 0; i < lines.length; i++) {
      checkProseLine(file, lines[i], i + 1);
    }
  }
}

// 2b. Every page shows, not only tells: images it names exist, and the key pages carry a picture.
function checkImagesExist(markdownFiles: string[]) {
  for (const file of markdownFiles) {
    for (const match of read(file).matchAll(IMAGE)) {
      const imagePath = match[1];
      if (/^https?:/.test(imagePath)) continue;
      if (!existsSync(join(dirname(file), imagePath))) {
        fail(file, `image "${imagePath}" does not exist`);
      }
    }
  }
}

type PictureNeeds = { mermaid: boolean; image: boolean };

function needPicture(file: string, what: string, needs: PictureNeeds) {
  if (!existsSync(file)) {
    fail(file, "missing");
    return;
  }
  const text = read(file);
  if (needs.mermaid && !MERMAID.test(text)) fail(file, `${what} needs a Mermaid diagram`);
  if (needs.image && !hasImage(text)) fail(file, `${what} needs a screenshot`);
}

// 3. Parts and steps.
function checkPartReadme(readme: string) {
  const text = read(readme);
  if (!MERMAID.test(text)) fail(readme, "part README needs a Mermaid diagram");
  const walkthrough = section(text, "## Walkthrough");
  if (walkthrough === undefined) {
    fail(readme, `part README needs a "## Walkthrough" section`);
  } else if (!walkthrough.includes("```bash")) {
    fail(readme, "the walkthrough needs the commands, each with an Expect: line");
  }
}

function checkStepName(step: Step, seen: Set<string>) {
  if (!VERB_THING.test(step.name)) {
    fail(step.dir, `step name "${step.name}" must be verb-thing in lower case`);
  }
  if (seen.has(step.name)) fail(step.dir, `step name "${step.name}" is used twice`);
  seen.add(step.name);
}

function checkStepMeta(step: Step) {
  if (!existsSync(join(step.dir, "step.toml"))) fail(step.dir, "missing step.toml");
  const minutes = step.meta.minutes;
  if (minutes < 5 || minutes > 30) {
    fail(step.dir, `step is ${minutes} min; keep a step between 5 and 30, split it if longer`);
  }
}

function checkStepReadme(step: Step, stepReadme: string) {
  const text = read(stepReadme);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 600) {
    fail(stepReadme, `${words} words; a step README stays under 600, split the step`);
  }
  for (const heading of STEP_SECTIONS) {
    if (!text.includes(heading)) fail(stepReadme, `missing section "${heading}"`);
  }
  if (!MERMAID.test(text) && !hasImage(text)) {
    fail(stepReadme, "a step shows a picture: a screenshot or a Mermaid diagram");
  }
  const doneWhen = section(text, "## Done when") ?? "";
  if (!/^- /m.test(doneWhen)) fail(stepReadme, "Done when needs at least one bullet");
  if (step.meta.screen) checkScreenStep(step, stepReadme, text);
}

// A step with a screen shows the learner what the finished screen looks like.
function checkScreenStep(step: Step, stepReadme: string, text: string) {
  const expectedImage = join(step.dir, "images", "expected.png");
  if (!existsSync(expectedImage)) fail(step.dir, "screen step needs images/expected.png");
  if (!text.includes("images/expected.png")) {
    fail(stepReadme, "screen step must show ../images/expected.png");
  }
}

function checkStepFiles(step: Step) {
  if (step.meta.solution && !existsSync(join(step.dir, "solution"))) {
    fail(step.dir, "step.toml says solution but there is no solution/");
  }
  const typescriptCheck = join(ROOT, "checks", `${step.name}.ts`);
  const pythonCheck = join(ROOT, "checks", `${step.name}.py`);
  if (!existsSync(typescriptCheck) && !existsSync(pythonCheck)) {
    fail(step.dir, `no check at checks/${step.name}.ts`);
  }
}

function checkStep(step: Step, seen: Set<string>) {
  checkStepName(step, seen);
  checkStepMeta(step);
  const stepReadme = join(step.dir, "problem", "README.md");
  // Without a README the rest of the step cannot be judged yet, so stop here.
  if (!existsSync(stepReadme)) {
    fail(step.dir, "missing problem/README.md");
    return;
  }
  checkStepReadme(step, stepReadme);
  checkStepFiles(step);
}

function checkParts(allParts: Part[]) {
  const seen = new Set<string>();
  if (allParts.length === 0) fail(join(ROOT, "parts"), "no parts");
  for (const part of allParts) {
    const readme = join(part.dir, "README.md");
    if (!existsSync(readme)) {
      fail(part.dir, "part has no README.md");
    } else {
      checkPartReadme(readme);
    }
    // A part skeleton waits for its own build session: it may have no steps while its README
    // says TODO(part session).
    const skeleton = existsSync(readme) && read(readme).includes("TODO(part session)");
    if (part.steps.length === 0 && !skeleton) fail(part.dir, "part has no steps");
    for (const step of part.steps) {
      checkStep(step, seen);
    }
  }
}

// 4. Commands: the README runs the finished system first, and every command block says what
// to expect.
function checkRootReadme() {
  const rootReadme = join(ROOT, "README.md");
  if (!existsSync(rootReadme)) {
    fail(ROOT, "missing README.md");
    return;
  }
  const text = read(rootReadme);
  const firstCode = text.indexOf("```bash");
  const firstConcept = text.search(/^## (How it works|Concepts|Background|Why)/m);
  if (firstCode < 0) {
    fail(rootReadme, "the README needs a bash block that runs the finished system");
  } else if (firstConcept >= 0 && firstConcept < firstCode) {
    fail(rootReadme, "run the finished system before any concept section");
  }
}

function checkExpectLinesIn(file: string) {
  const lines = read(file).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "```bash") continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "```") j++;
    const linesAfter = lines.slice(j + 1);
    const nextText = linesAfter.find((line) => line.trim() !== "");
    if (!nextText?.startsWith("Expect:")) {
      fail(file, `line ${i + 1}: a bash block must be followed by an Expect: line`);
    }
    i = j;
  }
}

function checkExpectLines(markdownFiles: string[]) {
  for (const file of markdownFiles) checkExpectLinesIn(file);
}

// 5. One model config, exact pins, a troubleshooting table.
function checkModelIds(files: string[]) {
  const scanned = files.filter(
    (file) =>
      /\.(ts|py|md|json|toml|ya?ml)$/.test(file) &&
      !file.includes("/config/models.") &&
      !file.includes("/scripts/check.ts"),
  );
  for (const file of scanned) {
    const modelId = read(file).match(MODEL_ID);
    if (modelId) {
      fail(file, `model id "${modelId[0]}" outside config/models; name models in one place`);
    }
  }
}

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function checkPins() {
  const packagePath = join(ROOT, "package.json");
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(read(packagePath)) as PackageJson;
    const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const [name, version] of Object.entries(allDependencies)) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fail(packagePath, `${name}@${version}: pin an exact version`);
      }
    }
  }
  const pyproject = join(ROOT, "pyproject.toml");
  if (existsSync(pyproject)) {
    const looseRequirement = /"([A-Za-z0-9_.\-[\]]+)\s*(>=|~=|\^|>|<)[^"]*"/g;
    for (const match of read(pyproject).matchAll(looseRequirement)) {
      fail(pyproject, `${match[1]}: pin with == not ${match[2]}`);
    }
  }
}

function checkTroubleshooting() {
  const trouble = join(ROOT, "00-orientation", "troubleshooting.md");
  if (!existsSync(trouble) || !TROUBLE_TABLE.test(read(trouble))) {
    fail(
      ROOT,
      "00-orientation/troubleshooting.md needs a table: What you see | What it means | Fix",
    );
  }
}

// 6. Every schedule covers every part, and the minutes add up.
type Schedule = { sessions: { parts: string[]; minutes: number }[] };
type Schedules = Record<string, Schedule>;

type ScheduleToCheck = {
  path: string;
  format: string;
  schedule: Schedule;
  partMinutes: Record<string, number>;
};

function checkOneSchedule(allParts: Part[], toCheck: ScheduleToCheck) {
  const { path, format, schedule, partMinutes } = toCheck;
  const listed = schedule.sessions.flatMap((session) => session.parts);
  for (const part of allParts) {
    if (!listed.includes(part.name)) fail(path, `${format} leaves out part "${part.name}"`);
  }
  for (const session of schedule.sessions) {
    const need = session.parts.reduce((total, name) => total + (partMinutes[name] ?? 0), 0);
    if (need > session.minutes) {
      fail(path, `${format}: a session needs ${need} min but has ${session.minutes}`);
    }
  }
}

function checkSchedules(allParts: Part[]) {
  const schedulePath = join(ROOT, "schedules.toml");
  if (!existsSync(schedulePath)) {
    fail(ROOT, "missing schedules.toml");
    return;
  }
  const schedules = Bun.TOML.parse(read(schedulePath)) as Schedules;
  const minutesOf = (part: Part) =>
    part.steps.reduce((total, step) => total + step.meta.minutes, 0);
  const partMinutes = Object.fromEntries(allParts.map((part) => [part.name, minutesOf(part)]));
  for (const [format, schedule] of Object.entries(schedules)) {
    checkOneSchedule(allParts, { path: schedulePath, format, schedule, partMinutes });
  }
}

const files = walk(ROOT);
const markdownFiles = files.filter((file) => file.endsWith(".md"));
checkNoMakefile(files);
checkProse(markdownFiles);
checkImagesExist(markdownFiles);
needPicture(join(ROOT, "README.md"), "the root README", { mermaid: true, image: true });
needPicture(join(ROOT, "00-orientation", "README.md"), "the orientation", {
  mermaid: false,
  image: true,
});
const allParts = parts();
checkParts(allParts);
checkRootReadme();
checkExpectLines(markdownFiles);
checkModelIds(files);
checkPins();
checkTroubleshooting();
checkSchedules(allParts);

if (errors.length) {
  console.log(`The repo does not meet the standard. ${errors.length} problem(s):`);
  for (const error of errors) console.log(`  - ${error}`);
  process.exit(1);
}
console.log(
  `The repo meets the standard: ${allParts.length} part(s), ${allSteps().length} step(s).`,
);

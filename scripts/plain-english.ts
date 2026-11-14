// bun run plain-english: every page reads easily for a beginner
// whose first language is not English.
//
// Short sentences, everyday words, and an example on every teaching page.
// Code blocks, tables and headings are skipped: they are not sentences.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { ROOT } from "./structure";

// A course for everyone (no code) can lower this in package.json: "plainEnglish": { "grade": 6 }.
const DEFAULT_READING_GRADE = 6;
const LONGEST_SENTENCE = 25;

const SKIPPED_FOLDERS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "recordings",
  "research",
  "fixtures",
]);

// Pages for the people who build the course, not for learners.
const AUTHOR_PAGES = new Set(["STANDARD.md", "SPEC.md", "PARTS.md"]);

// Words that make a reader reach for a dictionary, and the everyday word to use instead.
const SIMPLER_WORDS: Record<string, string> = {
  utilize: "use",
  utilise: "use",
  facilitate: "help",
  commence: "start",
  terminate: "end or stop",
  subsequently: "then",
  approximately: "about",
  sufficient: "enough",
  "prior to": "before",
  "in order to": "to",
  numerous: "many",
  obtain: "get",
  endeavor: "try",
  ascertain: "find out",
  thereby: "so",
  hence: "so",
  thus: "so",
  whereas: "while",
  "e.g.": "for example",
  "i.e.": "that is",
  "etc.": "the full list",
  via: "through or with",
  paradigm: "way of working",
  robust: "strong, or say what it survives",
  "in terms of": "a plainer phrase",
  "it is worth noting": "nothing; just say it",
  basically: "nothing; cut it",
  simply: "nothing; cut it",
  obviously: "nothing; cut it",
  "just ": "nothing; cut it",
};

type Problem = { file: string; message: string };

function markdownFiles(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder)) {
    if (SKIPPED_FOLDERS.has(entry)) continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) markdownFiles(path, found);
    else if (path.endsWith(".md") && !AUTHOR_PAGES.has(entry)) found.push(path);
  }
  return found;
}

// The fence that a line opens or closes a code block with, or "" for any other line.
function fenceOn(line: string): string {
  return line.trim().match(/^`{3,}/)?.[0] ?? "";
}

// Which fence is open after this line: "" outside a code block.
// A block closes only on a fence at least as long as the one that opened it,
// so a ```yaml block quoted inside a ````text block stays inside.
function openFenceAfter(line: string, openFence: string): string {
  const fence = fenceOn(line);
  if (openFence === "") return fence;
  if (fence.length >= openFence.length) return "";
  return openFence;
}

const COMMAND_WORDS = new Set([
  "bun",
  "bunx",
  "git",
  "claude",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "uv",
  "make",
  "pip",
  "python",
  "node",
  "fail",
  "pass",
  "error",
  "docker",
  "gh",
  "cd",
  "ls",
  "cat",
  "curl",
  "echo",
  "export",
  "cp",
  "mv",
  "mkdir",
  "rm",
]);
const MOST_WORDS_IN_CODE = 2;

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

// A span of 3 or more words with no command, path, flag, URL, file name or code in it is English.
function isBacktickedEnglish(inside: string): boolean {
  if (wordCount(inside) <= MOST_WORDS_IN_CODE) return false;
  if (/[/.(=$]|--/.test(inside) || inside.trim().startsWith("-")) return false;
  // "bun: command not found" and "FAIL ..." are output the learner sees, not English to rewrite.
  const [firstWord] = inside.trim().split(/\s+/);
  const commandName = firstWord.toLowerCase().replace(/:$/, "");
  return !COMMAND_WORDS.has(commandName);
}

// Every line outside a code fence, headings included, with command spans taken out.
function textOutsideCode(markdown: string): string {
  const kept: string[] = [];
  let openFence = "";
  for (const line of markdown.split("\n")) {
    const isFence = fenceOn(line) !== "";
    openFence = openFenceAfter(line, openFence);
    if (!isFence && openFence === "") kept.push(line);
  }
  const noCommands = kept.join("\n").replace(/`([^`\n]*)`/g, (span, inside) => {
    return isBacktickedEnglish(inside) ? span : "";
  });
  return noCommands.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function backtickProblems(file: string, markdown: string): Problem[] {
  const spans = textOutsideCode(markdown).match(/`[^`\n]*`/g) ?? [];
  const message = "backticked English: say it in plain words, keep backticks for what you type";
  return spans.map((span) => ({ file, message: `${message} (${span})` }));
}

// Exact times go stale and make a learner feel slow. A rough word costs nothing.
const MINUTES = /\b\d+(?:\s*(?:-|to)\s*\d+)?\s*(?:minutes?|mins?)\b/gi;

function minutesProblems(file: string, markdown: string): Problem[] {
  const found = textOutsideCode(markdown).match(MINUTES) ?? [];
  const advice = "use a rough word like an evening";
  return found.map((text) => ({ file, message: `exact minutes "${text}": ${advice}` }));
}

// Lockfiles already pin versions. A page that repeats one goes out of date.
const TOOLS = "Bun|Node|Node\\.js|Python|Go|Java|Rust|Deno|npm|React|TypeScript|Docker|Claude|Git";
const VERSIONS = [
  /\bv\d+(?:\.\d+)*\b/g,
  /(?<![\d.-])(?!\d{4}\.)\d{1,3}\.\d+\.\d+(?![\d.]*\d{4})\b/g,
  new RegExp(`\\b(?:${TOOLS})\\s+v?\\d+(?:\\.\\d+)*\\b(?![/%])`, "g"),
  /\b[A-Z][A-Za-z]+\s+\d+\.\d+(?:\.\d+)*\b(?!%)/g,
];

function versionProblems(file: string, markdown: string): Problem[] {
  const text = textOutsideCode(markdown);
  const all = [...new Set(VERSIONS.flatMap((pattern) => text.match(pattern) ?? []))];
  // "Bun 1.3.2" also contains "1.3.2"; report the version once.
  const found = all.filter((one) => !all.some((other) => other !== one && other.includes(one)));
  const advice = 'say "install Bun", not the number';
  return found.map((text) => ({ file, message: `version number "${text}": ${advice}` }));
}

// A date makes a page feel old. Say what a thing is, not when it appeared.
const YEAR = "(?:20(?:1[5-9]|2\\d|3\\d))";
const MONTH = [
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?",
  "Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)",
].join("|");
const DATES = [
  new RegExp(`(?<![\\d./-])${YEAR}(?![\\d]|[./-]\\d)`, "g"),
  new RegExp(`\\b${MONTH}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?\\b|${YEAR}\\b)`, "g"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "g"),
  /\bas of\s+(?:\d|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b)/gi,
  /\blast updated\b/gi,
  /\bupdated on\b/gi,
  /\bnew in\s+\d{4}\b/gi,
  /\breleased in\b/gi,
];

function dateProblems(file: string, markdown: string): Problem[] {
  const text = textOutsideCode(markdown);
  const found = text.split("\n").flatMap((line) => {
    const hits = DATES.flatMap((pattern) => line.match(pattern) ?? []);
    return hits.length === 0 ? [] : [line];
  });
  return found.map((line) => ({
    file,
    message: `date in prose: say what it is, not when (${line.trim().slice(0, 40)})`,
  }));
}

// Keep only the lines a person reads as sentences.
export function proseOf(markdown: string): string {
  const proseLines: string[] = [];
  let openFence = "";
  for (const line of markdown.split("\n")) {
    const isFence = fenceOn(line) !== "";
    openFence = openFenceAfter(line, openFence);
    const isStructure = /^\s*(#|\||<|!\[|Expect:)/.test(line);
    if (!isFence && openFence === "" && !isStructure) proseLines.push(line);
  }
  // Inline code stays on one line, so a stray backtick cannot hide the paragraphs after it.
  // Code becomes "it". English inside a span stays, so it counts toward the grade.
  const withoutInlineCode = proseLines
    .join("\n")
    .replace(/`([^`\n]*)`/g, (_span, inside) =>
      isBacktickedEnglish(inside) || wordCount(inside) === 2 ? inside : "it",
    );
  return withoutInlineCode.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

export function sentencesOf(prose: string): string[] {
  const paragraphs = prose.split(/\n\s*\n|\n\s*[-*\d]+[.)]?\s/);
  const sentences = paragraphs.flatMap((paragraph) => paragraph.split(/(?<=[.!?:])\s+/));
  const tidied = sentences.map((sentence) => sentence.replace(/\s+/g, " ").trim());
  return tidied.filter(Boolean);
}

const wordsOf = (sentence: string) => sentence.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];

export function syllablesIn(word: string): number {
  const lower = word.toLowerCase().replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  const vowelGroups = lower.match(/[aeiouy]{1,2}/g);
  return Math.max(1, vowelGroups ? vowelGroups.length : 1);
}

// Flesch-Kincaid grade level: about the school year a reader needs to follow the text.
export function readingGrade(sentences: string[]): number {
  const words = sentences.flatMap(wordsOf);
  if (sentences.length === 0 || words.length === 0) return 0;
  const syllables = words.reduce((total, word) => total + syllablesIn(word), 0);
  const wordsPerSentence = words.length / sentences.length;
  const syllablesPerWord = syllables / words.length;
  return 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
}

function isTeachingPage(file: string): boolean {
  const path = relative(ROOT, file);
  const isStepReadme = /problem\/README\.md$/.test(path);
  const isPartReadme = /^parts\/[^/]+\/README\.md$/.test(path);
  return isStepReadme || isPartReadme || path === "README.md";
}

function hardWordProblems(file: string, prose: string): Problem[] {
  const problems: Problem[] = [];
  const lowerProse = ` ${prose.toLowerCase()} `;
  for (const [hardWord, simpler] of Object.entries(SIMPLER_WORDS)) {
    const escaped = hardWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`[^a-z]${escaped}(?![a-z])`);
    if (pattern.test(lowerProse)) {
      problems.push({ file, message: `"${hardWord.trim()}": write ${simpler}` });
    }
  }
  return problems;
}

function sentenceProblems(file: string, sentences: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const sentence of sentences) {
    const count = wordsOf(sentence).length;
    if (count > LONGEST_SENTENCE) {
      const opening = sentence.split(" ").slice(0, 8).join(" ");
      problems.push({ file, message: `${count}-word sentence "${opening}..."; split it` });
    }
  }
  return problems;
}

export function problemsIn(file: string, markdown: string, gradeLimit: number): Problem[] {
  const prose = proseOf(markdown);
  const sentences = sentencesOf(prose);
  const problems = [
    ...hardWordProblems(file, prose),
    ...sentenceProblems(file, sentences),
    ...backtickProblems(file, markdown),
    ...minutesProblems(file, markdown),
    ...versionProblems(file, markdown),
    ...dateProblems(file, markdown),
  ];

  const grade = readingGrade(sentences);
  if (sentences.length >= 5 && grade > gradeLimit) {
    const shown = grade.toFixed(1);
    const message = `reading grade ${shown}, above ${gradeLimit}; use shorter words`;
    problems.push({ file, message });
  }
  if (isTeachingPage(file) && !/\bfor example\b/i.test(markdown)) {
    problems.push({ file, message: 'no "For example": show one real case, not only the rule' });
  }
  return problems;
}

function configuredGrade(): number {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const grade = packageJson.plainEnglish?.grade;
  return typeof grade === "number" ? grade : DEFAULT_READING_GRADE;
}

// The check tests itself first: code quoted inside a longer fence is never read as prose.
function fencesAreSkipped(): boolean {
  const sample = ["Intro.", "````text", "```yaml", "quoted: inside", "```", "````", "Outro."];
  return !proseOf(sample.join("\n")).includes("quoted");
}

if (import.meta.main) {
  if (!fencesAreSkipped()) {
    console.error("plain-english.ts reads quoted code as prose. Fix proseOf first.");
    process.exit(1);
  }
  const gradeLimit = configuredGrade();
  // Named files narrow the run (check:changed and the prose test). Author pages stay skipped.
  const named = process.argv.slice(2).map((file) => resolve(ROOT, file));
  const files =
    named.length > 0
      ? named.filter((file) => !AUTHOR_PAGES.has(basename(file)))
      : markdownFiles(ROOT);
  const readProblems = (file: string) => problemsIn(file, readFileSync(file, "utf8"), gradeLimit);
  const problemsInFile = readProblems;
  const problems = files.flatMap(problemsInFile);
  for (const problem of problems) {
    console.error(`${relative(ROOT, problem.file)}: ${problem.message}`);
  }
  if (problems.length > 0) {
    console.error(`${problems.length} plain-English problems. See STANDARD.md, "Plain English".`);
    process.exit(1);
  }
  const summary = "Every page reads plainly: short sentences, everyday words";
  console.log(`${summary}, grade ${gradeLimit} or below.`);
}

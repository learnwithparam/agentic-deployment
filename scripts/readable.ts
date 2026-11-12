// bun run readable: code a beginner can read like English, in every language the repo uses.
//
// Formatters and linters own spacing, function length and nesting:
//   Biome for TypeScript and JavaScript, ruff for Python, the language's own formatter otherwise.
// This file owns what they miss: names that are words, one idea per line, short lines.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { ROOT } from "./structure";

const LONGEST_LINE = 100;
const MOST_CALLS_IN_ONE_LINE = 3;

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".rs", ".sh"]);
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", ".venv", "recordings"]);

// Short names a beginner already knows. Everything else is a whole word.
const ALLOWED_SHORT_NAMES = new Set(["i", "j", "id", "ok", "db", "fs", "os", "io", "ui"]);

// Abbreviations that make a reader stop and decode. Each one has a plain word to use instead.
const ABBREVIATIONS: Record<string, string> = {
  ctx: "context",
  cfg: "config",
  conf: "config",
  tmp: "temporary or what it holds",
  res: "response or result",
  req: "request",
  resp: "response",
  obj: "what the object is",
  arr: "what the list holds",
  val: "value or what it is",
  str: "what the text is",
  num: "what the number counts",
  idx: "index",
  cnt: "count",
  msg: "message",
  fn: "what the function does",
  cb: "what the callback does",
  evt: "event",
  buf: "buffer",
  acc: "total or what it collects",
  elem: "element",
  pod: "what it holds",
  util: "what it does",
  utils: "what they do",
  mgr: "manager",
  svc: "service",
  impl: "what it implements",
};

type Problem = { file: string; line: number; message: string };

const DECLARED_NAMES: RegExp[] = [
  /\b(?:const|let|var|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:def|class)\s+([A-Za-z_]\w*)/g,
  /\bfor\s+(?:const\s+|let\s+)?\(?\s*([A-Za-z_]\w*)\s+(?:in|of)\b/g,
  /^\s*([A-Za-z_]\w*)\s*(?::=|=(?!=))/g,
  /\blambda\s+([A-Za-z_]\w*)/g,
  /\(([A-Za-z_$][\w$]*)\)\s*=>/g,
  /(?:^|[\s(,=])([A-Za-z_$][\w$]*)\s*=>/g,
];

const PARAMETER_LISTS: RegExp[] = [
  /\bfunction\s*[\w$]*\s*\(([^)]*)\)/g,
  /\bdef\s+\w+\s*\(([^)]*)\)/g,
  /\(([^()]*)\)\s*(?::\s*[\w<>[\]|, ]+)?\s*=>/g,
];

export function namesDeclaredOn(line: string): string[] {
  const names: string[] = [];
  for (const pattern of DECLARED_NAMES) {
    for (const match of line.matchAll(pattern)) names.push(match[1]);
  }
  for (const pattern of PARAMETER_LISTS) {
    for (const match of line.matchAll(pattern)) names.push(...parameterNames(match[1]));
  }
  return names;
}

function parameterNames(list: string): string[] {
  const names: string[] = [];
  for (const piece of list.split(",")) {
    const name = piece
      .trim()
      .replace(/^\.\.\./, "")
      .split(/[\s:=?]/)[0];
    if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "self" && name !== "cls") names.push(name);
  }
  return names;
}

export function nameProblem(name: string): string | undefined {
  if (name.startsWith("_") && name.length > 1) return nameProblem(name.slice(1));
  if (name === "_") return undefined;
  const lower = name.toLowerCase();
  if (lower in ABBREVIATIONS) return `"${name}" is an abbreviation; write ${ABBREVIATIONS[lower]}`;
  if (name.length <= 2 && !ALLOWED_SHORT_NAMES.has(lower)) {
    return `"${name}" is too short to read; name what it holds in a whole word`;
  }
  return undefined;
}

function callsOn(line: string): number {
  const calls = line.match(/\.[A-Za-z_$][\w$]*\(/g);
  return calls ? calls.length : 0;
}

function hasTwoTernaries(line: string): boolean {
  const withoutOptionalChains = line.replace(/\?\.|\?\?/g, "");
  const questionMarks = withoutOptionalChains.match(/\s\?\s/g);
  return questionMarks !== null && questionMarks.length >= 2;
}

function isCommentOrText(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*");
}

function problemsOnLine(line: string): string[] {
  const messages: string[] = [];
  if (line.length > LONGEST_LINE) {
    messages.push(`line is ${line.length} characters; keep it under ${LONGEST_LINE + 1}`);
  }
  if (isCommentOrText(line)) return messages;

  if (callsOn(line) > MOST_CALLS_IN_ONE_LINE) {
    messages.push("too many steps on one line; give each step its own line and a named result");
  }
  if (hasTwoTernaries(line)) messages.push("two ternaries on one line; use if and else");

  for (const name of namesDeclaredOn(line)) {
    const problem = nameProblem(name);
    if (problem) messages.push(problem);
  }
  return messages;
}

export function problemsIn(file: string, text: string): Problem[] {
  const problems: Problem[] = [];
  text.split("\n").forEach((line, index) => {
    for (const message of problemsOnLine(line)) {
      problems.push({ file, line: index + 1, message });
    }
  });
  return problems;
}

function codeFiles(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder)) {
    if (SKIPPED_FOLDERS.has(entry)) continue;
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) codeFiles(path, found);
    else if (CODE_EXTENSIONS.has(extname(path))) found.push(path);
  }
  return found;
}

function runTool(command: string[], whatItChecks: string): boolean {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) console.error(`${whatItChecks} failed. Run the fix command above.`);
  return result.exitCode === 0;
}

function formattersPass(files: string[]): boolean {
  let passed = runTool(
    ["bunx", "@biomejs/biome@2.6.5", "check", "."],
    "Biome (TypeScript and JavaScript)",
  );
  const hasPython = files.some((file) => file.endsWith(".py"));
  if (hasPython) {
    passed = runTool(["uvx", "ruff@0.17.4", "format", "--check", "."], "ruff format") && passed;
    passed = runTool(["uvx", "ruff@0.17.4", "check", "."], "ruff check") && passed;
  }
  return passed;
}

if (import.meta.main) {
  const files = codeFiles(ROOT);
  const problems = files.flatMap((file) => problemsIn(file, readFileSync(file, "utf8")));
  for (const problem of problems) {
    console.error(`${relative(ROOT, problem.file)}:${problem.line}: ${problem.message}`);
  }
  const formatted = formattersPass(files);
  if (problems.length > 0 || !formatted) {
    console.error(`${problems.length} readability problems. See STANDARD.md, "Readable code".`);
    process.exit(1);
  }
  console.log("The code reads like English: whole-word names, one idea per line, formatted.");
}

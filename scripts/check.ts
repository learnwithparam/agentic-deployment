// bun run check: the repo standard. CI runs this; any failure stops the build.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ROOT, parts, allSteps } from "./structure";

const errors: string[] = [];
const fail = (where: string, what: string) => errors.push(`${relative(ROOT, where) || "."}: ${what}`);
const read = (p: string) => readFileSync(p, "utf8");

const STEP_SECTIONS = ["## The problem", "## Your challenge", "## Done when", "## If you get stuck", "## Words you will use"];
const HYPE = /\b(supercharge|unleash|unlock|seamless(ly)?|leverage|dive into|game[- ]changer|revolutioni[sz]e|magic(al)?|cutting[- ]edge|AI-powered)\b/i;
const TIME_WORDS = /\b(week|day|hour)\s+\d+\b/i;
const VERB_THING = /^[a-z]+(-[a-z0-9]+)+$/;

// 1. No Makefile anywhere.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(ROOT);
for (const f of files) if (/(^|\/)(GNU)?[Mm]akefile$/.test(f)) fail(f, "a Makefile is not allowed; use a Bun or uv script");

// 2. Prose rules on every Markdown file.
for (const f of files.filter((f) => f.endsWith(".md"))) {
  const text = read(f);
  text.split("\n").forEach((line, i) => {
    if (line.includes("—")) fail(f, `line ${i + 1}: em dash`);
    const h = line.match(HYPE);
    if (h) fail(f, `line ${i + 1}: hype word "${h[0]}"`);
    const t = line.match(TIME_WORDS);
    if (t && !f.includes("schedules")) fail(f, `line ${i + 1}: "${t[0]}"; content is in parts, schedules map time`);
    if (/\bM=\d+|verify \d+/.test(line)) fail(f, `line ${i + 1}: numeric step command; name the step`);
  });
}

// 2b. Every page shows, not only tells: images it names exist, and the key pages carry a picture.
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const MERMAID = /```mermaid\n/;
const hasImage = (t: string) => [...t.matchAll(IMAGE)].length > 0;
for (const f of files.filter((f) => f.endsWith(".md"))) {
  for (const m of read(f).matchAll(IMAGE)) {
    if (/^https?:/.test(m[1])) continue;
    if (!existsSync(join(dirname(f), m[1]))) fail(f, `image "${m[1]}" does not exist`);
  }
}
const needPicture = (f: string, what: string, mermaid: boolean, image: boolean) => {
  if (!existsSync(f)) return fail(f, "missing");
  const t = read(f);
  if (mermaid && !MERMAID.test(t)) fail(f, `${what} needs a Mermaid diagram`);
  if (image && !hasImage(t)) fail(f, `${what} needs a screenshot`);
};
needPicture(join(ROOT, "README.md"), "the root README", true, true);
needPicture(join(ROOT, "00-orientation", "README.md"), "the orientation", false, true);

// 3. Parts and steps.
const seen = new Set<string>();
const ps = parts();
if (ps.length === 0) fail(join(ROOT, "parts"), "no parts");
for (const p of ps) {
  const readme = join(p.dir, "README.md");
  if (!existsSync(readme)) fail(p.dir, "part has no README.md");
  else {
    const t = read(readme);
    if (!MERMAID.test(t)) fail(readme, "part README needs a Mermaid diagram");
    const walk = t.split("## Walkthrough")[1]?.split("\n## ")[0];
    if (walk === undefined) fail(readme, `part README needs a "## Walkthrough" section`);
    else if (!walk.includes("```bash")) fail(readme, "the walkthrough needs the commands, each with an Expect: line");
  }
  if (p.steps.length === 0) fail(p.dir, "part has no steps");
  for (const s of p.steps) {
    if (!VERB_THING.test(s.name)) fail(s.dir, `step name "${s.name}" must be verb-thing in lower case`);
    if (seen.has(s.name)) fail(s.dir, `step name "${s.name}" is used twice`);
    seen.add(s.name);
    if (!existsSync(join(s.dir, "step.toml"))) fail(s.dir, "missing step.toml");
    if (s.meta.minutes < 5 || s.meta.minutes > 30) fail(s.dir, `step is ${s.meta.minutes} min; keep a step between 5 and 30, split it if longer`);
    const sr = join(s.dir, "problem", "README.md");
    if (!existsSync(sr)) { fail(s.dir, "missing problem/README.md"); continue; }
    const text = read(sr);
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words > 600) fail(sr, `${words} words; a step README stays under 600, split the step`);
    for (const h of STEP_SECTIONS) if (!text.includes(h)) fail(sr, `missing section "${h}"`);
    if (!MERMAID.test(text) && !hasImage(text)) fail(sr, "a step shows a picture: a screenshot or a Mermaid diagram");
    const done = text.split("## Done when")[1]?.split("\n## ")[0] ?? "";
    if (!/^- /m.test(done)) fail(sr, "Done when needs at least one bullet");
    if (s.meta.screen) {
      const img = join(s.dir, "images", "expected.png");
      if (!existsSync(img)) fail(s.dir, "screen step needs images/expected.png");
      if (!text.includes("images/expected.png")) fail(sr, "screen step must show ../images/expected.png");
    }
    if (s.meta.solution && !existsSync(join(s.dir, "solution"))) fail(s.dir, "step.toml says solution but there is no solution/");
    if (!existsSync(join(ROOT, "checks", `${s.name}.ts`)) && !existsSync(join(ROOT, "checks", `${s.name}.py`)))
      fail(s.dir, `no check at checks/${s.name}.ts`);
  }
}

// 4. Commands: the README runs the finished system first, and every command block says what to expect.
const MODEL_ID = /\b(claude-[a-z0-9-]+-\d|gpt-\d[\w.-]*|gemini-\d[\w.-]*|o\d-(mini|pro)\b)/i;
const rootReadme = join(ROOT, "README.md");
if (!existsSync(rootReadme)) fail(ROOT, "missing README.md");
else {
  const t = read(rootReadme);
  const firstCode = t.indexOf("```bash");
  const firstConcept = t.search(/^## (How it works|Concepts|Background|Why)/m);
  if (firstCode < 0) fail(rootReadme, "the README needs a bash block that runs the finished system");
  else if (firstConcept >= 0 && firstConcept < firstCode) fail(rootReadme, "run the finished system before any concept section");
}
for (const f of files.filter((f) => f.endsWith(".md"))) {
  const lines = read(f).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "```bash") continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "```") j++;
    const after = lines.slice(j + 1).find((l) => l.trim() !== "");
    if (!after?.startsWith("Expect:")) fail(f, `line ${i + 1}: a bash block must be followed by an Expect: line`);
    i = j;
  }
}
// 5. One model config, exact pins, a troubleshooting table.
for (const f of files.filter((f) => /\.(ts|py|md|json|toml|ya?ml)$/.test(f) && !f.includes("/config/models.") && !f.includes("/scripts/check.ts"))) {
  const m = read(f).match(MODEL_ID);
  if (m) fail(f, `model id "${m[0]}" outside config/models; name models in one place`);
}
const pkg = join(ROOT, "package.json");
if (existsSync(pkg)) {
  const j = JSON.parse(read(pkg));
  for (const [n, v] of Object.entries({ ...j.dependencies, ...j.devDependencies } as Record<string, string>))
    if (!/^\d+\.\d+\.\d+$/.test(v)) fail(pkg, `${n}@${v}: pin an exact version`);
}
const py = join(ROOT, "pyproject.toml");
if (existsSync(py)) for (const m of read(py).matchAll(/"([A-Za-z0-9_.\-\[\]]+)\s*(>=|~=|\^|>|<)[^"]*"/g)) fail(py, `${m[1]}: pin with == not ${m[2]}`);
const trouble = join(ROOT, "00-orientation", "troubleshooting.md");
if (!existsSync(trouble) || !/\| *What you see *\| *What it means *\| *Fix *\|/.test(read(trouble)))
  fail(ROOT, "00-orientation/troubleshooting.md needs a table: What you see | What it means | Fix");

// 6. Every schedule covers every part, and the minutes add up.
const schedPath = join(ROOT, "schedules.toml");
if (!existsSync(schedPath)) fail(ROOT, "missing schedules.toml");
else {
  const sched = Bun.TOML.parse(read(schedPath)) as Record<string, { sessions: { parts: string[]; minutes: number }[] }>;
  const partMinutes = Object.fromEntries(ps.map((p) => [p.name, p.steps.reduce((a, s) => a + s.meta.minutes, 0)]));
  for (const [fmt, def] of Object.entries(sched)) {
    const listed = def.sessions.flatMap((x) => x.parts);
    for (const p of ps) if (!listed.includes(p.name)) fail(schedPath, `${fmt} leaves out part "${p.name}"`);
    for (const x of def.sessions) {
      const need = x.parts.reduce((a, n) => a + (partMinutes[n] ?? 0), 0);
      if (need > x.minutes) fail(schedPath, `${fmt}: a session needs ${need} min but has ${x.minutes}`);
    }
  }
}

if (errors.length) {
  console.log(`The repo does not meet the standard. ${errors.length} problem(s):`);
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log(`The repo meets the standard: ${ps.length} part(s), ${allSteps().length} step(s).`);

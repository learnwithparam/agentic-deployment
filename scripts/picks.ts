// Checks the "## Watch and read" table in every part README (standard section 5).
// Only runs when package.json has "picks": true, so courses opt in when ready.
// Run: bun scripts/picks.ts            (LINKS=1 also checks that links are live)
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parts, ROOT } from "./structure";

const MIN_ROWS = 4;
const MAX_ROWS = 6;
const MIN_VIDEOS = 2;

export type Pick = { kind: string; title: string; author: string; why: string; link: string };

export function readDenylist(root: string): string[] {
  const own = join(root, "picks.denylist.json");
  const path = existsSync(own) ? own : join(ROOT, "picks.denylist.json");
  return JSON.parse(readFileSync(path, "utf8")).hosts as string[];
}

function parseRow(line: string): Pick | undefined {
  const cells = line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
  const kind = cells[0]?.toLowerCase() ?? "";
  // The header and the dashed divider are not picks.
  if (kind === "kind" || /^:?-+:?$/.test(kind)) return undefined;
  const [, title = "", author = "", why = "", link = ""] = cells;
  return { kind, title, author, why, link: link.replace(/^<|>$/g, "") };
}

export function readPicks(readme: string): Pick[] | undefined {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^##\s+Watch and read\s*$/i.test(line));
  if (start < 0) return undefined;
  const picks: Pick[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    const pick = parseRow(line);
    if (pick) picks.push(pick);
  }
  return picks;
}

export function hostOf(link: string): string | undefined {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function isDenied(host: string, denylist: string[]): boolean {
  return denylist.some((entry) => {
    if (entry.startsWith("*")) return host.endsWith(entry.slice(1));
    return host === entry || host.endsWith(`.${entry}`);
  });
}

function problemsForPick(pick: Pick, denylist: string[]): string[] {
  const label = pick.title || pick.link || "a pick";
  const problems: string[] = [];
  if (pick.kind !== "video" && pick.kind !== "read") {
    problems.push(`"${label}" has kind "${pick.kind}"; use video or read`);
  }
  if (!pick.why) problems.push(`"${label}" has no reason in the why column`);
  const host = hostOf(pick.link);
  if (!host) problems.push(`"${label}" has a link that is not a web address`);
  else if (isDenied(host, denylist)) {
    problems.push(`"${label}" links to ${host}, which is a listicle, SEO or paywall site`);
  }
  return problems;
}

export function problemsForPart(readme: string, denylist: string[]): string[] {
  const picks = readPicks(readme);
  if (!picks) return ["there is no '## Watch and read' table"];
  const problems: string[] = [];
  if (picks.length < MIN_ROWS || picks.length > MAX_ROWS) {
    problems.push(`has ${picks.length} picks; it needs ${MIN_ROWS} to ${MAX_ROWS}`);
  }
  const videos = picks.filter((pick) => pick.kind === "video").length;
  if (videos < MIN_VIDEOS) problems.push(`has ${videos} videos; it needs at least ${MIN_VIDEOS}`);
  for (const pick of picks) problems.push(...problemsForPick(pick, denylist));
  return problems;
}

async function isLive(link: string): Promise<boolean> {
  const host = hostOf(link) ?? "";
  const youtube = host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
  try {
    if (youtube) {
      // Plain YouTube pages answer 200 even for removed videos; oEmbed does not.
      const api = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`;
      return (await fetch(api, { signal: AbortSignal.timeout(15000) })).ok;
    }
    const options = { redirect: "follow", signal: AbortSignal.timeout(15000) } as const;
    const head = await fetch(link, { method: "HEAD", ...options });
    if (head.ok) return true;
    // Some servers refuse HEAD but serve GET.
    return (await fetch(link, { method: "GET", ...options })).ok;
  } catch {
    return false;
  }
}

function picksTurnedOn(root: string): boolean {
  const packagePath = join(root, "package.json");
  const settings = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : {};
  return settings.picks === true;
}

async function deadLinks(readme: string, where: string): Promise<string[]> {
  const problems: string[] = [];
  for (const pick of readPicks(readme) ?? []) {
    if (pick.link && !(await isLive(pick.link))) {
      problems.push(`${where}: "${pick.title}" link is not live: ${pick.link}`);
    }
  }
  return problems;
}

async function problemsForReadme(path: string, root: string, denylist: string[], live: boolean) {
  const where = relative(root, path);
  if (!existsSync(path)) return [`${where}: the part has no README`];
  const readme = readFileSync(path, "utf8");
  const problems = problemsForPart(readme, denylist).map((problem) => `${where}: ${problem}`);
  if (live) problems.push(...(await deadLinks(readme, where)));
  return problems;
}

export async function checkRoot(root: string, live: boolean): Promise<string[]> {
  if (!picksTurnedOn(root)) {
    console.log("picks: skipped, this course has not turned picks on");
    return [];
  }
  const denylist = readDenylist(root);
  const problems: string[] = [];
  for (const part of parts(root)) {
    problems.push(...(await problemsForReadme(join(part.dir, "README.md"), root, denylist, live)));
  }
  if (!live) console.log("picks: link liveness skipped; set LINKS=1 to check that links are live");
  return problems;
}

if (import.meta.main) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag > 0 ? join(process.cwd(), process.argv[rootFlag + 1]) : ROOT;
  const problems = await checkRoot(root, process.env.LINKS === "1");
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length) process.exit(1);
  console.log("picks: ok");
}

// biome-ignore-all lint/style/useNamingConvention: Prometheus names the field runbook_url
// write-the-runbook: runbook.md has six sections with something in each, every alert links to a
// heading in it, and its kill switch command stops every model call within 10 seconds.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { admin, runCommand, secret } from "../world/cli/lib";
import { ROOT, URLS, world } from "./lib/world";

const HEADINGS = [
  "Symptoms",
  "First five minutes",
  "Kill switch",
  "Roll back",
  "Who to tell",
  "After",
];
type AlertRule = { alert?: string; annotations?: { runbook_url?: string } };
type AlertFile = { groups?: { rules?: AlertRule[] }[] };

function runbook(dir: string): string {
  const file = join(dir, "runbook.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** The text under each "## " heading, by heading. */
function sections(markdown: string): Map<string, string> {
  const found = new Map<string, string>();
  const pieces = markdown.split(/^## /m).slice(1);
  for (const piece of pieces) {
    const [heading, ...body] = piece.split("\n");
    found.set(heading.trim(), body.join("\n"));
  }
  return found;
}

// A section is empty when every line in it is blank or starts with TODO.
function isEmpty(body: string): boolean {
  const lines = body.split("\n").map((line) => line.trim());
  return lines.every((line) => line === "" || line.startsWith("TODO"));
}

/** The anchor GitHub gives a heading: lower case, no punctuation, spaces become hyphens. */
function anchorOf(heading: string): string {
  const lower = heading.trim().toLowerCase();
  return lower.replace(/[^a-z0-9 _-]/g, "").replace(/ /g, "-");
}

function alertRules(dir: string): AlertRule[] {
  const file = join(dir, "prometheus", "alerts.yml");
  if (!existsSync(file)) return [];
  const parsed = Bun.YAML.parse(readFileSync(file, "utf8")) as AlertFile;
  const groups = parsed.groups ?? [];
  return groups.flatMap((group) => group.rules ?? []).filter((rule) => rule.alert);
}

function linksToHeading(rule: AlertRule, anchors: string[]): boolean {
  const link = rule.annotations?.runbook_url ?? "";
  const [page, anchor] = link.split("#");
  return page.endsWith("runbook.md") && anchors.includes(anchor);
}

/** The first bash block in the Kill switch section, or an empty string. */
function killSwitchCommand(dir: string): string {
  const body = sections(runbook(dir)).get("Kill switch") ?? "";
  return body.match(/```bash\n([\s\S]*?)```/)?.[1]?.trim() ?? "";
}

async function gatewayKilled(): Promise<boolean> {
  const response = await fetch(`${URLS.gateway}/health`);
  const health = (await response.json()) as { killed?: boolean };
  return health.killed === true;
}

// A model call with the desk's own key, the way a desk would send it.
async function modelCallRefused(): Promise<boolean> {
  const response = await fetch(`${URLS.gateway}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret("desk_gateway_key")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hello" }] }),
  });
  return response.status === 503;
}

// Run the learner's kill switch from the top of the repo, then always turn the gateway back on.
async function killSwitchWorks(dir: string): Promise<boolean> {
  const command = killSwitchCommand(dir);
  if (!command) return false;
  await world();
  await admin("/admin/revive", {});
  const startedAt = Date.now();
  const running = runCommand(["bash", "-c", command], { cwd: ROOT });
  await Promise.race([running, Bun.sleep(10_000)]);
  let killed = false;
  while (!killed && Date.now() - startedAt < 10_000) {
    killed = await gatewayKilled();
    if (!killed) await Bun.sleep(250);
  }
  const refused = killed && (await modelCallRefused());
  await admin("/admin/revive", {});
  return refused;
}

const killSwitchByFolder = new Map<string, Promise<boolean>>();
function killSwitchResult(dir: string): Promise<boolean> {
  let result = killSwitchByFolder.get(dir);
  if (!result) {
    result = killSwitchWorks(dir);
    killSwitchByFolder.set(dir, result);
  }
  return result;
}

function namesSomeoneToTell(dir: string): boolean {
  const body = sections(runbook(dir)).get("Who to tell") ?? "";
  const peopleFile = readFileSync(join(ROOT, "world", "data", "people.json"), "utf8");
  const people = JSON.parse(peopleFile).people as { name: string; roles: string[] }[];
  const staff = people.filter((person) => !person.roles.includes("resident"));
  return staff.some((person) => body.includes(person.name));
}

export default [
  {
    says: `runbook.md has the sections ${HEADINGS.join(", ")}`,
    test: (dir) => {
      const found = sections(runbook(dir));
      return HEADINGS.every((heading) => found.has(heading));
    },
    tryNext: "Use these exact headings, each on its own line, starting with ## and a space.",
  },
  {
    says: "no section is empty or only says TODO",
    test: (dir) => {
      const found = sections(runbook(dir));
      return HEADINGS.every((heading) => !isEmpty(found.get(heading) ?? ""));
    },
    tryNext: "Write at least one line under each heading. Say what a person does, in order.",
  },
  {
    says: "every alert in prometheus/alerts.yml has a runbook_url that points to a heading",
    test: (dir) => {
      const rules = alertRules(dir);
      const anchors = [...sections(runbook(dir)).keys()].map(anchorOf);
      return rules.length > 0 && rules.every((rule) => linksToHeading(rule, anchors));
    },
    tryNext:
      'Under annotations, add runbook_url: "runbook.md#roll-back".' +
      " The part after # is the heading in lower case, with hyphens for spaces.",
  },
  {
    says: "the Kill switch command, run from the top of the repo, stops every model call in 10 s",
    test: killSwitchResult,
    tryNext:
      "Put a bash block under Kill switch that calls POST localhost:7002/admin/kill" +
      " with the admin key from secrets/gateway_admin_key.",
  },
  {
    says: "Who to tell names someone on the council's staff list",
    test: namesSomeoneToTell,
    tryNext:
      "Name people from world/data/people.json," +
      " for example the team lead and the budget holder.",
  },
] satisfies Rule[];

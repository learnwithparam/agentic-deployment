// deploy-your-own-agent: the learner's own agent, not the course desk. The check reads the
// learner's folder and proves its shape and that evidence exists. It never starts the
// course world.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";

const textOf = (dir: string, name: string) => {
  const file = join(dir, name);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

// Every text file in the folder, so a secret cannot hide in a file the check forgot.
function everyFile(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...everyFile(path));
    else found.push(path);
  }
  return found;
}

function section(text: string, heading: string): string {
  const parts = text.split(/^## /m).slice(1);
  const wanted = heading.toLowerCase();
  const found = parts.find((part) => part.toLowerCase().startsWith(wanted));
  return found ? found.split("\n").slice(1).join("\n") : "";
}

const hasNoTodo = (text: string) => !/\bTODO\b/.test(text);

function runsAsNotRoot(dockerfile: string): boolean {
  const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gim)].map((match) => match[1]);
  const last = users.at(-1);
  return last !== undefined && last !== "root" && last !== "0";
}

function keyInEnvironment(compose: string): boolean {
  return /^\s+[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\s*[:=]\s*\S+/m.test(compose);
}

const LOOKS_LIKE_A_KEY = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,})/;

function releaseNumbers(dir: string): boolean {
  try {
    const release = JSON.parse(textOf(dir, "release.json"));
    const steps = Number(release.max_steps);
    const dollars = Number(release.max_cost_usd);
    const timeout = Number(release.timeout_ms);
    const named = typeof release.id === "string" && hasNoTodo(release.id) && release.id !== "";
    return named && steps >= 1 && steps <= 50 && dollars > 0 && dollars <= 5 && timeout > 0;
  } catch {
    return false;
  }
}

// A heading counts as evidence when it holds a command that starts with "$ " and a line of output.
function hasEvidence(evidence: string, heading: string): boolean {
  const block = section(evidence, heading).match(/```[^\n]*\n([\s\S]*?)```/);
  const lines = (block?.[1] ?? "").split("\n").filter((line) => line.trim() !== "");
  const command = lines.findIndex((line) => line.startsWith("$ "));
  return command !== -1 && lines.length > command + 1;
}

export default [
  {
    says: "the Dockerfile runs the agent as a user that is not root, and has a HEALTHCHECK",
    test: (dir) => {
      const dockerfile = textOf(dir, "Dockerfile");
      return hasNoTodo(dockerfile) && runsAsNotRoot(dockerfile) && /^HEALTHCHECK/m.test(dockerfile);
    },
    tryNext: "Add a USER line for a user that is not root, and a HEALTHCHECK line. Remove TODOs.",
  },
  {
    says: "the key is a secret file in compose.yaml, and not an environment value",
    test: (dir) => {
      const compose = textOf(dir, "compose.yaml");
      const asSecret = /^\s*secrets:\s*$/m.test(compose) && /file:\s*\S+/.test(compose);
      return hasNoTodo(compose) && asSecret && !keyInEnvironment(compose);
    },
    tryNext: "Use a secrets: block with a file. Take any key out of environment and the image.",
  },
  {
    says: "no file in the folder holds something that looks like a real key",
    test: (dir) => {
      const holdsKey = (file: string) => LOOKS_LIKE_A_KEY.test(readFileSync(file, "utf8"));
      return !everyFile(dir).some(holdsKey);
    },
    tryNext: "Move the key into the secret file, which stays out of git. Remove it from here.",
  },
  {
    says: "release.json has an id, a step limit, a dollar limit and a timeout",
    test: (dir) => releaseNumbers(dir),
    tryNext: "Fill in id, max_steps (1 to 50), max_cost_usd (more than 0, up to 5) and timeout_ms.",
  },
  {
    says: "runbook.md has a Kill switch, a Roll back and a Who to tell section, none empty",
    test: (dir) => {
      const runbook = textOf(dir, "runbook.md");
      const headings = ["Kill switch", "Roll back", "Who to tell"];
      return headings.every((heading) => {
        const body = section(runbook, heading).trim();
        return body.length > 20 && hasNoTodo(body);
      });
    },
    tryNext: "Write the real command or the real names under each heading. Remove every TODO.",
  },
  {
    says: "EVIDENCE.md has a date and real output for health, roll back and kill switch",
    test: (dir) => {
      const evidence = textOf(dir, "EVIDENCE.md");
      const dated = /^Date:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(evidence);
      const headings = ["Health", "Roll back", "Kill switch"];
      return dated && headings.every((heading) => hasEvidence(evidence, heading));
    },
    tryNext: "Run each command on your agent. Paste it after a $, then paste its output below it.",
  },
] satisfies Rule[];

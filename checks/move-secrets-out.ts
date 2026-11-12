// move-secrets-out: no key in the image or the environment; the desk reads its own gateway key
// from a secret file.

import { basename } from "node:path";
import type { Rule } from "../scripts/verify";
import { runCommand } from "../world/cli/lib";
import { composeConfig, container, image, startDesk } from "./lib/desk";
import { findInImage } from "./lib/image";
import { dataField, postRun } from "./lib/sse";
import { replayMode, resetWorld, secret, spend } from "./lib/world";

const PROVIDER_KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"];

// Every key the desk must never carry. Short or empty provider keys would match anything.
function keys(): string[] {
  const providerKeys = PROVIDER_KEY_NAMES.map((name) => process.env[name] ?? "");
  const realProviderKeys = providerKeys.filter((key) => key.length > 8);
  return [
    secret("gateway_admin_key"),
    secret("desk_gateway_key"),
    "hdc-admin-",
    ...realProviderKeys,
  ];
}

function envHoldsKey(variable: string): boolean {
  const holdsKnownKey = keys().some((key) => variable.includes(key));
  return holdsKnownKey || /^(ANTHROPIC|OPENROUTER|OPENAI)_API_KEY=/.test(variable);
}

async function mountsOwnKey(dir: string): Promise<boolean> {
  const config = await composeConfig(dir);
  const deskSecrets = config?.services?.desk?.secrets ?? [];
  const names = deskSecrets.map((mounted) => mounted.source);
  return names.some((name) => basename(config?.secrets?.[name]?.file ?? "") === "desk_gateway_key");
}

async function billedToOwnKey(dir: string): Promise<boolean> {
  if (!(await startDesk(dir)).ok || !(await replayMode())) return false;
  await resetWorld();
  const run = await postRun("HDC-2026-0142");
  const doneEvent = run.events.find((event) => event.event === "done");
  const runId = doneEvent && dataField(doneEvent, "run_id");
  const rows = (await spend()).filter((row) => row.run_id === runId);
  return rows.length > 0 && rows.every((row) => row.key === "desk");
}

async function dockerInspect(format: string, id: string): Promise<string> {
  const inspected = await runCommand(["docker", "inspect", "-f", format, id]);
  return inspected.out.trim();
}

// Start the image with no key file mounted, and see whether it stops and names the missing file.
async function stopsWithoutKeyFile(dir: string): Promise<boolean> {
  if (!(await startDesk(dir)).ok) return false;
  const imageName = await image();
  if (!imageName) return false;
  const started = await runCommand(["docker", "run", "-d", "--network", "hdc", imageName]);
  const id = started.out.trim();
  if (!id) return false;
  let exited = false;
  for (let i = 0; i < 20 && !exited; i++) {
    await Bun.sleep(500);
    exited = (await dockerInspect("{{.State.Running}}", id)) === "false";
  }
  const code = Number(await dockerInspect("{{.State.ExitCode}}", id));
  const logs = await runCommand(["docker", "logs", id]);
  await runCommand(["docker", "rm", "-f", id]);
  const printed = logs.out + logs.err;
  return exited && code !== 0 && /key/i.test(printed) && /\/run\/secrets|file/i.test(printed);
}

export default [
  {
    says: "the image holds no gateway key or provider key, in any layer, its config or its history",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const imageName = await image();
      if (!imageName) return false;
      return (await findInImage(imageName, keys())).length === 0;
    },
    tryNext:
      "Remove the ARG and ENV lines that carry GATEWAY_KEY from the Dockerfile," +
      " and the build args from compose.yaml. Rebuild.",
  },
  {
    says: "the running desk has no key in its environment",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const env = (await container())?.Config?.Env ?? [];
      return !env.some(envHoldsKey);
    },
    tryNext:
      "Do not pass GATEWAY_KEY under environment either." +
      " A key in the environment shows in docker inspect and in crash reports.",
  },
  {
    says: "compose.yaml mounts the desk's own key (secrets/desk_gateway_key) as a secret",
    test: mountsOwnKey,
    tryNext:
      "Declare a top-level secret gateway_key with file: " +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is Compose's ${VAR:-default} syntax for the learner to copy, not a template
      "${HDC_SECRETS:-../../../../secrets}/desk_gateway_key and list it under the desk service.",
  },
  {
    says: "model calls from the desk are billed to its own gateway key, not the admin key (replay mode)",
    test: billedToOwnKey,
    tryNext:
      "Read the key from /run/secrets/gateway_key in src/config.ts." +
      " The world made it for the desk, with a budget.",
  },
  {
    says: "without its key file the desk stops at once and says which file is missing",
    test: stopsWithoutKeyFile,
    tryNext:
      "In src/config.ts, check the key file exists before the server starts." +
      " If not, print its path and call process.exit(1).",
  },
] satisfies Rule[];

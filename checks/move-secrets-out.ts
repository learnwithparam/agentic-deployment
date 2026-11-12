// move-secrets-out: no key in the image or the environment; the desk reads its own gateway key from a secret file.
import type { Rule } from "../scripts/verify";
import { basename } from "node:path";
import { startDesk, composeConfig, container, image } from "./lib/desk";
import { findInImage } from "./lib/image";
import { postRun } from "./lib/sse";
import { resetWorld, secret, spend, replayMode } from "./lib/world";
import { sh } from "../world/cli/lib";

const keys = () => [secret("gateway_admin_key"), secret("desk_gateway_key"), "hdc-admin-",
  ...["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"].map((k) => process.env[k] ?? "").filter((v) => v.length > 8)];

export default [
  {
    says: "the image holds no gateway key or provider key, in any layer, its config or its history",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const img = await image();
      return Boolean(img) && (await findInImage(img!, keys())).length === 0;
    },
    tryNext: "Remove the ARG and ENV lines that carry GATEWAY_KEY from the Dockerfile, and the build args from compose.yaml. Rebuild.",
  },
  {
    says: "the running desk has no key in its environment",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const env: string[] = (await container())?.Config?.Env ?? [];
      return !env.some((e) => keys().some((k) => e.includes(k)) || /^(ANTHROPIC|OPENROUTER|OPENAI)_API_KEY=/.test(e));
    },
    tryNext: "Do not pass GATEWAY_KEY under environment either. A key in the environment shows in docker inspect and in crash reports.",
  },
  {
    says: 'compose.yaml mounts the desk\'s own key (secrets/desk_gateway_key) as a secret',
    test: async (dir) => {
      const cfg = await composeConfig(dir);
      const mine = (cfg?.services?.desk?.secrets ?? []).map((s: any) => s.source);
      return mine.some((name: string) => basename(cfg?.secrets?.[name]?.file ?? "") === "desk_gateway_key");
    },
    tryNext: 'Declare a top-level secret gateway_key with file: ${HDC_SECRETS:-../../../../secrets}/desk_gateway_key and list it under the desk service.',
  },
  {
    says: "model calls from the desk are billed to its own gateway key, not the admin key (replay mode)",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok || !(await replayMode())) return false;
      await resetWorld();
      const r = await postRun("HDC-2026-0142");
      const runId = r.events.find((e) => e.event === "done")?.data?.run_id;
      const rows = (await spend()).filter((s) => s.run_id === runId);
      return rows.length > 0 && rows.every((s) => s.key === "desk");
    },
    tryNext: "Read the key from /run/secrets/gateway_key in src/config.ts. The world made it for the desk, with a budget.",
  },
  {
    says: "without its key file the desk stops at once and says which file is missing",
    test: async (dir) => {
      if (!(await startDesk(dir)).ok) return false;
      const img = await image();
      const run = await sh(["docker", "run", "-d", "--network", "hdc", img!]);
      const id = run.out.trim();
      if (!id) return false;
      let exited = false;
      for (let i = 0; i < 20 && !exited; i++) {
        await Bun.sleep(500);
        exited = (await sh(["docker", "inspect", "-f", "{{.State.Running}}", id])).out.trim() === "false";
      }
      const code = Number((await sh(["docker", "inspect", "-f", "{{.State.ExitCode}}", id])).out.trim());
      const logs = await sh(["docker", "logs", id]);
      await sh(["docker", "rm", "-f", id]);
      return exited && code !== 0 && /key/i.test(logs.out + logs.err) && /\/run\/secrets|file/i.test(logs.out + logs.err);
    },
    tryNext: "In src/config.ts, check the key file exists before the server starts. If not, print its path and call process.exit(1).",
  },
] satisfies Rule[];

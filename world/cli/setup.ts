// bun run setup: check this machine can run the course, and say what to do when it cannot.

import { existsSync } from "node:fs";
import { sh } from "./lib";

let bad = 0;
const ok = (good: boolean, yes: string, no: string) => {
  console.log(good ? `  ok    ${yes}` : `  FIX   ${no}`);
  if (!good) bad++;
};

const docker = await sh(["docker", "info", "--format", "{{json .}}"]).catch(() => ({
  code: 1,
  out: "",
  err: "",
}));
ok(
  docker.code === 0,
  "Docker is running",
  "Docker is not running. Start Docker Desktop (or the Docker service) and run bun run setup again.",
);
if (docker.code === 0) {
  const info = JSON.parse(docker.out);
  const gb = Number(info.MemTotal ?? 0) / 1024 ** 3;
  ok(
    gb >= 4,
    `Docker can use ${gb.toFixed(1)} GB of memory`,
    `Docker can use only ${gb.toFixed(1)} GB. Give it at least 4 GB in Docker Desktop, Settings, Resources.`,
  );
  const compose = await sh(["docker", "compose", "version", "--short"]);
  const [maj, min] = compose.out.trim().split(".").map(Number);
  ok(
    compose.code === 0 && (maj > 2 || (maj === 2 && min >= 24)),
    `Docker Compose ${compose.out.trim()}`,
    "Docker Compose 2.24 or newer is needed. Update Docker Desktop.",
  );
}
const busy: number[] = [];
for (const port of [3000, 7001, 7002, 7003, 7004, 7010, 8080, 9090, 9093]) {
  try {
    const s = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    s.stop(true);
  } catch {
    busy.push(port);
  }
}
const ours =
  (await sh(["docker", "ps", "--format", "{{.Names}}"])).out
    .split("\n")
    .filter((n) => n.startsWith("hdc-")).length > 0;
ok(
  busy.length === 0 || ours,
  "ports 3000, 7001 to 7004, 7010, 8080, 9090 and 9093 are free",
  `ports ${busy.join(", ")} are in use by another program. Stop it, or change the port in the compose files.`,
);
ok(
  true,
  existsSync(".env")
    ? ".env found; the provider comes from LLM_PROVIDER"
    : "no .env, so the model provider is replay (no key needed)",
  "",
);
console.log(
  bad ? `${bad} thing(s) to fix before you start.` : "This machine is ready. Next: bun run world",
);
process.exit(bad ? 1 : 0);

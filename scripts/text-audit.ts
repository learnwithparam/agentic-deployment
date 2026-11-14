// biome-ignore-all lint/style/useNamingConvention: environment variable names stay upper case
// bun run text-audit: start the permit desk and its world on this machine (no Docker), open every
// route in a real browser, and run the 10 text checks. See e2e/page-checks.js.
// A repo with no e2e/routes.ts has no pages yet, so there is nothing to audit.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTS } from "../e2e/ports";
import { ROOT } from "./structure";

const routesFile = join(ROOT, "e2e", "routes.ts");

if (!existsSync(routesFile)) {
  console.log("Text audit skipped: e2e/routes.ts does not exist yet.");
  console.log("Try next: copy e2e/routes.example.ts to e2e/routes.ts when the course has pages.");
  process.exit(0);
}

const configFile = join(ROOT, "e2e", "playwright.config.ts");
const deskFolder = join(ROOT, "world", "finished", "desk");

function installOrStop(command: string[], folder: string, message: string) {
  const result = Bun.spawnSync(command, { cwd: folder, stdout: "ignore", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(message);
    process.exit(2);
  }
}

installOrStop(["bun", "install"], ROOT, "Could not install packages. Try next: run bun install.");
installOrStop(
  ["bun", "install"],
  deskFolder,
  "Could not install the desk packages. Try next: run bun install in world/finished/desk.",
);
// Set PLAYWRIGHT_CHROMIUM to a Chromium path to skip the download, like bun run shots.
if (!process.env.PLAYWRIGHT_CHROMIUM) {
  installOrStop(
    ["bunx", "playwright", "install", "chromium"],
    ROOT,
    "Could not get the browser. Try next: run bunx playwright install chromium.",
  );
}

const workFolder = mkdtempSync(join(tmpdir(), "text-audit-"));
const secretsFolder = join(workFolder, "secrets");
mkdirSync(secretsFolder);
const auditUser = "amara.okafor";
const auditPassword = "audit-password";
writeFileSync(join(secretsFolder, "gateway_key"), "audit-key\n");
writeFileSync(join(secretsFolder, "desk_client_secret"), "audit-secret\n");
writeFileSync(join(secretsFolder, "passwords"), JSON.stringify({ [auditUser]: auditPassword }));

const deskUrls = {
  REGISTER_URL: `http://localhost:${PORTS.register}`,
  GATEWAY_URL: `http://localhost:${PORTS.gateway}`,
  IDP_URL: `http://localhost:${PORTS.idp}`,
  ISSUER: `http://localhost:${PORTS.idp}`,
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${PORTS.traces}`,
};
const services = [
  {
    file: "world/register/server.ts",
    port: PORTS.register,
    env: { REGISTER_DATA: join(workFolder, "register") },
  },
  { file: "world/idp/server.ts", port: PORTS.idp, env: { IDP_DATA: join(workFolder, "idp") } },
  {
    file: "world/traces/server.ts",
    port: PORTS.traces,
    env: { TRACES_DATA: join(workFolder, "traces") },
  },
  {
    file: "world/finished/desk/src/server.ts",
    port: PORTS.desk,
    env: {
      ...deskUrls,
      GATEWAY_KEY_FILE: join(secretsFolder, "gateway_key"),
      DESK_DATA: join(workFolder, "desk"),
      RELEASE_FILE: join(deskFolder, "release.json"),
      CLIENT_SECRET_FILE: join(secretsFolder, "desk_client_secret"),
    },
  },
];

const running = services.map((service) =>
  Bun.spawn(["bun", service.file], {
    cwd: ROOT,
    env: {
      ...process.env,
      SECRETS_DIR: secretsFolder,
      ...service.env,
      PORT: String(service.port),
    },
    stdout: "ignore",
    stderr: "inherit",
  }),
);

async function waitForService(url: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // Not answering yet; try again after a short wait.
    }
    await Bun.sleep(250);
  }
  throw new Error(`${url} did not answer. Try next: start that service by hand to see why.`);
}

let exitCode = 1;
try {
  for (const service of services) await waitForService(`http://localhost:${service.port}/`);
  const audit = Bun.spawn(["bunx", "playwright", "test", "-c", configFile, "--trace", "off"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUDIT_URL: `http://localhost:${PORTS.desk}`,
      AUDIT_USER: auditUser,
      AUDIT_PASSWORD: auditPassword,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await audit.exited;
  if (exitCode !== 0) {
    console.error(
      "The text audit found problems. Try next: fix the lines marked above, then rerun.",
    );
  }
} catch (error) {
  console.error((error as Error).message);
} finally {
  for (const child of running) child.kill();
  rmSync(workFolder, { recursive: true, force: true });
}
process.exit(exitCode === 0 ? 0 : 1);

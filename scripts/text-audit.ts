// biome-ignore-all lint/style/useNamingConvention: environment variable names stay upper case
// bun run text-audit: start the permit desk and its world on this machine (no Docker), open every
// page the audit lists in e2e/routes.ts, and check the words on it. See e2e/page-checks.js.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./structure";

const work = mkdtempSync(join(tmpdir(), "text-audit-"));
const secrets = join(work, "secrets");
mkdirSync(secrets);
const PASSWORD = "audit-password";
writeFileSync(join(secrets, "gateway_key"), "audit-key\n");
writeFileSync(join(secrets, "desk_client_secret"), "audit-secret\n");
writeFileSync(join(secrets, "passwords"), JSON.stringify({ "amara.okafor": PASSWORD }));

const base = { ...process.env, SECRETS_DIR: secrets };
const localUrls = {
  REGISTER_URL: "http://localhost:7001",
  GATEWAY_URL: "http://localhost:7002",
  IDP_URL: "http://localhost:7003",
  ISSUER: "http://localhost:7003",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:7004",
};
const services = [
  { file: "world/register/server.ts", env: { REGISTER_DATA: join(work, "register") }, port: 7001 },
  { file: "world/idp/server.ts", env: { IDP_DATA: join(work, "idp") }, port: 7003 },
  { file: "world/traces/server.ts", env: { TRACES_DATA: join(work, "traces") }, port: 7004 },
  {
    file: "world/finished/desk/src/server.ts",
    env: {
      ...localUrls,
      GATEWAY_KEY_FILE: join(secrets, "gateway_key"),
      DESK_DATA: join(work, "desk"),
      RELEASE_FILE: join(ROOT, "world/finished/desk/release.json"),
      CLIENT_SECRET_FILE: join(secrets, "desk_client_secret"),
    },
    port: 3000,
  },
];

// CI runs this before anything else has installed packages, so install the audit's own first.
await Bun.spawn(["bun", "install", "--frozen-lockfile"], { cwd: ROOT, stdout: "ignore" }).exited;
const playwright = join(ROOT, "node_modules", ".bin", "playwright");
if (!process.env.PLAYWRIGHT_CHROMIUM) {
  await Bun.spawn([playwright, "install", "chromium"], { cwd: ROOT, stdout: "ignore" }).exited;
}

// The desk has its own packages, which the Docker build installs. Install them here the same way.
await Bun.spawn(["bun", "install", "--frozen-lockfile"], {
  cwd: join(ROOT, "world/finished/desk"),
  stdout: "ignore",
}).exited;

const children = services.map((service) =>
  Bun.spawn(["bun", service.file], {
    cwd: ROOT,
    env: { ...base, ...service.env, PORT: String(service.port) },
    stdout: "ignore",
    stderr: "inherit",
  }),
);

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`${url} did not answer. Start the service by hand to see why.`);
}

let code = 1;
try {
  for (const service of services) await waitFor(`http://localhost:${service.port}/`);
  const audit = Bun.spawn([playwright, "test", "-c", "e2e/playwright.config.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUDIT_URL: "http://localhost:3000",
      AUDIT_USER: "amara.okafor",
      AUDIT_PASSWORD: PASSWORD,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  code = await audit.exited;
} finally {
  for (const child of children) child.kill();
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);

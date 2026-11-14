// biome-ignore-all lint/style/useNamingConvention: we keep release.json's names, like max_steps
// Where the desk finds the rest of the council. Defaults are the names inside the Docker network.
import { existsSync, readFileSync } from "node:fs";

export const PORT = Number(process.env.PORT ?? 3000);
export const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
export const REGISTER_URL = process.env.REGISTER_URL ?? "http://register:7001";
export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://gateway:7002";

// The sign-in service has two addresses. The desk reaches it inside the network at IDP_URL.
export const IDP_URL = process.env.IDP_URL ?? "http://idp:7003";
// The browser reaches it at ISSUER, and every token it signs names ISSUER as its maker.
export const ISSUER = process.env.ISSUER ?? "http://localhost:7003";

// A release is one version of the desk's behaviour: its prompt, its model role and its limits.
export type Release = {
  id: string;
  role: string;
  prompt: string;
  max_steps: number;
  max_cost_usd: number;
};
const RELEASE_FILE = process.env.RELEASE_FILE ?? "release.json";
// The desk reads the release at the start of every run, so a new release needs no restart.
export const currentRelease = (): Release => JSON.parse(readFileSync(RELEASE_FILE, "utf8"));
export const release: Release = currentRelease();

// A dry run reads the register but never writes to it. The eval gate and a shadow desk use it,
// so a test run can never send a resident a letter.
export const DRY_RUN = process.env.DRY_RUN === "1";

// The run journal lives here. Mount a volume on it so runs survive a new container.
export const DATA_DIR = process.env.DESK_DATA ?? "/data";

// Each resident may start this many runs in each window of time.
export const RATE_LIMIT = {
  runs: Number(process.env.RATE_LIMIT_RUNS ?? 5),
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000),
};

// The gateway key is a file, mounted by Docker Compose as a secret.
// It is never in the image or the environment, where anyone who can inspect the container sees it.
const GATEWAY_KEY_FILE = process.env.GATEWAY_KEY_FILE ?? "/run/secrets/gateway_key";
// Without a key every model call is refused, so stop now with a message that says what to fix.
if (!existsSync(GATEWAY_KEY_FILE)) {
  console.error(
    `The desk cannot start: its gateway key file ${GATEWAY_KEY_FILE} is missing. ` +
      `Mount it as the Compose secret "gateway_key".`,
  );
  process.exit(1);
}
const keyFromSecretFile = readFileSync(GATEWAY_KEY_FILE, "utf8").trim();

/** The gateway key this desk uses for every model call. */
export const gatewayKey = () => keyFromSecretFile;

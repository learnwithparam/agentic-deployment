// Where the desk finds the rest of the council. Defaults are the names inside the Docker network.
import { existsSync, readFileSync } from "node:fs";

export const PORT = Number(process.env.PORT ?? 3000);
export const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
export const REGISTER_URL = process.env.REGISTER_URL ?? "http://register:7001";
export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://gateway:7002";
export const IDP_URL = process.env.IDP_URL ?? "http://idp:7003"; // reached from inside the network
export const ISSUER = process.env.ISSUER ?? "http://localhost:7003"; // what the browser sees, and what tokens say

export type Release = { id: string; role: string; prompt: string; max_steps: number; max_cost_usd: number };
const RELEASE_FILE = process.env.RELEASE_FILE ?? "release.json";
/** The release is read at the start of every run, so a canary picks up a new release without a restart. */
export const currentRelease = (): Release => JSON.parse(readFileSync(RELEASE_FILE, "utf8"));
export const release: Release = currentRelease();
export const DATA_DIR = process.env.DESK_DATA ?? "/data";
export const RATE_LIMIT = { runs: Number(process.env.RATE_LIMIT_RUNS ?? 5), windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000) };

// The gateway key is a file, mounted by Docker Compose as a secret. It is never in the image or the environment.
const KEY_FILE = process.env.GATEWAY_KEY_FILE ?? "/run/secrets/gateway_key";
if (!existsSync(KEY_FILE)) {
  console.error(`The desk cannot start: its gateway key file ${KEY_FILE} is missing. Mount it as the Compose secret "gateway_key".`);
  process.exit(1);
}
const KEY = readFileSync(KEY_FILE, "utf8").trim();
/** The gateway key this desk uses for every model call. */
export const gatewayKey = () => KEY;

// biome-ignore-all lint/style/useNamingConvention: we keep release.json's names, like max_steps
// Where the desk finds the rest of the council. Defaults are the names inside the Docker network.
import { readFileSync } from "node:fs";

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
const releaseText = readFileSync(process.env.RELEASE_FILE ?? "release.json", "utf8");
export const release: Release = JSON.parse(releaseText);

/** The gateway key this desk uses for every model call. */
export const gatewayKey = () => process.env.GATEWAY_KEY ?? "";
if (!gatewayKey()) console.warn("GATEWAY_KEY is empty, so every model call will be refused.");

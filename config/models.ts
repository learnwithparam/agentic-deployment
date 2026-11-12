// The only file that names a model. Code asks for a role (fast, smart, judge), never an id.
// The provider comes from LLM_PROVIDER. "replay" is the default: no key, no network, the same reply every time.
// Ids and prices read from each provider's live list on the build date; recheck them before a cohort.

export const ROLES = ["fast", "smart", "judge"] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDERS = ["replay", "anthropic", "openrouter", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Model id per provider and role. Replay has no ids: it plays back the world's script. */
export const MODEL_IDS: Record<Exclude<Provider, "replay">, Record<Role, string>> = {
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5", judge: "claude-haiku-5-5" },
  openrouter: {
    fast: "nvidia/nemotron-3.5-lightning",
    smart: "anthropic/claude-sonnet-5.5",
    judge: "anthropic/claude-haiku-5.5",
  },
  openai: { fast: "gpt-6-luna", smart: "gpt-6-luna-pro", judge: "gpt-6-luna" },
};

/** The env var that holds the key for each real provider. Keys live in the git-ignored .env, never here. */
export const KEY_ENV: Record<Exclude<Provider, "replay">, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * USD per million tokens, [input, output]. A missing price means the gateway cannot price the call,
 * and the run is marked cost_unknown rather than zero.
 * Anthropic: platform.claude.com/docs/en/about-claude/pricing, read on the build date.
 * OpenRouter fast: the openrouter model page, as recorded in briefs/MODELS.md.
 * Replay is priced like the anthropic smart role, so the numbers in the course look like real ones.
 */
export const PRICES: Partial<Record<Provider, Partial<Record<Role, [number, number]>>>> = {
  replay: { fast: [2, 10], smart: [2, 10], judge: [2, 10] },
  anthropic: { fast: [0.1, 0.5], smart: [2, 10], judge: [0.1, 0.5] },
  openrouter: { fast: [0.07, 0.2] },
};

export function provider(env: Record<string, string | undefined> = process.env): Provider {
  const p = (env.LLM_PROVIDER ?? "replay").trim() as Provider;
  if (!PROVIDERS.includes(p))
    throw new Error(`LLM_PROVIDER="${p}" is not one of ${PROVIDERS.join(", ")}`);
  return p;
}

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}

export function price(
  p: Provider,
  role: Role,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pr = PRICES[p]?.[role];
  if (!pr) return null;
  return (inputTokens * pr[0] + outputTokens * pr[1]) / 1_000_000;
}

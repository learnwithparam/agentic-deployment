// bun run models: one tiny call per role on the provider LLM_PROVIDER names (from .env), then pass
// or fail and the cost. It never prints a key. With replay (the default) it needs no key and no
// network.
import { KEY_ENV, type Provider, price, provider, ROLES, type Role } from "../../config/models";
import { replay, tokens } from "../gateway/replay";

const MESSAGES = [
  { role: "system", content: "Answer in one word." },
  { role: "user", content: "Say ok. Application HDC-2026-0142." },
];

type TinyAnswer = { text: string; input: number; output: number };

async function askTinyQuestion(chosen: Provider, role: Role): Promise<TinyAnswer> {
  if (chosen === "replay") {
    const text = replay(MESSAGES, []).content ?? "";
    return { text, input: tokens(JSON.stringify(MESSAGES)), output: tokens(text) };
  }
  if (!process.env[KEY_ENV[chosen]]) throw new Error(`${KEY_ENV[chosen]} is not set in .env`);
  const { callProvider } = await import("../gateway/providers");
  const answer = await callProvider(chosen, role, MESSAGES, { tools: [], maxTokens: 16 });
  return { text: answer.content ?? "", input: answer.inputTokens, output: answer.outputTokens };
}

function costText(cost: number | null): string {
  return cost === null ? "unknown (no price in config/models.ts)" : `$${cost.toFixed(6)}`;
}

/** Try one role and print pass or FAIL. Returns whether it passed. */
async function tryRole(chosen: Provider, role: Role): Promise<boolean> {
  try {
    const { text, input, output } = await askTinyQuestion(chosen, role);
    if (!text) throw new Error("the model answered with no text");
    const cost = price(chosen, role, input, output);
    console.log(`  ${role.padEnd(6)} pass  ${input} in, ${output} out, cost ${costText(cost)}`);
    return true;
  } catch (error) {
    // Provider errors can echo the key back, so hide anything that looks like one.
    const message = (error as Error).message;
    const safeMessage = message.replace(/(sk|hdc)-[A-Za-z0-9_-]{8,}/g, "[key hidden]");
    console.log(`  ${role.padEnd(6)} FAIL  ${safeMessage}`);
    return false;
  }
}

let chosen: Provider = "replay";
try {
  chosen = provider();
} catch (error) {
  console.log((error as Error).message);
  process.exit(2);
}
console.log(`Provider: ${chosen}`);
let failed = 0;
for (const role of ROLES as readonly Role[]) {
  if (!(await tryRole(chosen, role))) failed++;
}
if (failed) console.log(`${failed} role(s) failed. Check the key and LLM_PROVIDER in .env.`);
else console.log("Every role answers.");
process.exit(failed ? 1 : 0);

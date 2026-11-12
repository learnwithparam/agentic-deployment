// bun run models: one tiny call per role on the provider LLM_PROVIDER names (from .env), then pass or fail
// and the cost. It never prints a key. With replay (the default) it needs no key and no network.
import { KEY_ENV, price, provider, ROLES, type Role } from "../../config/models";
import { replay, tokens } from "../gateway/replay";

let p;
try {
  p = provider();
} catch (e) {
  console.log((e as Error).message);
  process.exit(2);
}
console.log(`Provider: ${p}`);
let failed = 0;
for (const role of ROLES as readonly Role[]) {
  const messages = [
    { role: "system", content: "Answer in one word." },
    { role: "user", content: "Say ok. Application HDC-2026-0142." },
  ];
  try {
    let input = 0,
      output = 0,
      text = "";
    if (p === "replay") {
      const r = replay(messages, []);
      text = r.content ?? "";
      input = tokens(JSON.stringify(messages));
      output = tokens(text);
    } else {
      if (!process.env[KEY_ENV[p]]) throw new Error(`${KEY_ENV[p]} is not set in .env`);
      const { callProvider } = await import("../gateway/providers");
      const r = await callProvider(p, role, messages, [], 16);
      text = r.content ?? "";
      input = r.input_tokens;
      output = r.output_tokens;
    }
    if (!text) throw new Error("the model answered with no text");
    const c = price(p, role, input, output);
    console.log(
      `  ${role.padEnd(6)} pass  ${input} in, ${output} out, cost ${c === null ? "unknown (no price in config/models.ts)" : "$" + c.toFixed(6)}`,
    );
  } catch (e) {
    failed++;
    console.log(
      `  ${role.padEnd(6)} FAIL  ${(e as Error).message.replace(/(sk|hdc)-[A-Za-z0-9_-]{8,}/g, "[key hidden]")}`,
    );
  }
}
console.log(
  failed
    ? `${failed} role(s) failed. Check the key and LLM_PROVIDER in .env.`
    : "Every role answers.",
);
process.exit(failed ? 1 : 0);

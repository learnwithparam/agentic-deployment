// fall-back-when-a-provider-stalls: the desk gives up on a stalled provider and asks the next.
// This check needs no Docker. It starts three small fake providers on this machine.
import { join } from "node:path";
import type { Rule } from "../scripts/verify";

type Provider = { name: string; url: string };
type Answer = { provider: string; text: string };
type Ask = (providers: Provider[], question: string, timeoutMs: number) => Promise<Answer>;

const TIMEOUT_MS = 300;
const STALL_MS = 4000;

type Fakes = {
  hits: Record<string, number>;
  providers: Record<string, Provider>;
  stop: () => void;
};

// One fake provider that stalls, one that fails with a 500, and one that answers.
function startFakes(): Fakes {
  const hits: Record<string, number> = { stalls: 0, fails: 0, good: 0, spare: 0 };
  const behaviours: Record<string, () => Promise<Response>> = {
    stalls: async () => {
      await Bun.sleep(STALL_MS);
      return Response.json({ text: "too late" });
    },
    fails: async () => new Response("broken", { status: 500 }),
    good: async () => Response.json({ text: "an answer" }),
    spare: async () => Response.json({ text: "a spare answer" }),
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1);
      hits[name] = (hits[name] ?? 0) + 1;
      return behaviours[name]();
    },
  });
  const providers: Record<string, Provider> = {};
  for (const name of Object.keys(behaviours)) {
    providers[name] = { name, url: `http://localhost:${server.port}/${name}` };
  }
  return { hits, providers, stop: () => server.stop(true) };
}

async function loadAsk(dir: string): Promise<Ask> {
  const loaded = await import(join(dir, "src", "ask.ts"));
  return loaded.askWithFallback;
}

async function withFakes(dir: string, test: (ask: Ask, fakes: Fakes) => Promise<boolean>) {
  const ask = await loadAsk(dir);
  const fakes = startFakes();
  try {
    return await test(ask, fakes);
  } finally {
    fakes.stop();
  }
}

export default [
  {
    says: "a provider that stalls is given up on after the timeout, and the next one answers",
    test: (dir) =>
      withFakes(dir, async (ask, { providers }) => {
        const started = Date.now();
        const answer = await ask([providers.stalls, providers.good], "hi", TIMEOUT_MS);
        const waited = Date.now() - started;
        return answer.provider === "good" && waited < TIMEOUT_MS * 4;
      }),
    tryNext:
      "Pass signal: AbortSignal.timeout(timeoutMs) to fetch. Catch the error and try the next one.",
  },
  {
    says: "a provider that answers 500 is skipped, and the next one answers",
    test: (dir) =>
      withFakes(dir, async (ask, { providers }) => {
        const answer = await ask([providers.fails, providers.good], "hi", TIMEOUT_MS);
        return answer.provider === "good" && answer.text === "an answer";
      }),
    tryNext: "When response.ok is false, throw, so the loop moves on to the next provider.",
  },
  {
    says: "when no provider answers, it throws model_unavailable soon, and does not hang",
    test: (dir) =>
      withFakes(dir, async (ask, { providers }) => {
        const started = Date.now();
        let message = "";
        try {
          await ask([providers.stalls, providers.fails], "hi", TIMEOUT_MS);
        } catch (error) {
          message = (error as Error).message;
        }
        const soon = Date.now() - started < TIMEOUT_MS * 4;
        return message.startsWith("model_unavailable") && soon;
      }),
    tryNext: "After the loop, throw an Error whose message starts with model_unavailable.",
  },
  {
    says: "a healthy first provider answers alone: the spare is never asked",
    test: (dir) =>
      withFakes(dir, async (ask, { providers, hits }) => {
        const answer = await ask([providers.good, providers.spare], "hi", TIMEOUT_MS);
        await Bun.sleep(50);
        return answer.provider === "good" && hits.spare === 0;
      }),
    tryNext: "Ask the providers one at a time, in order. Do not start the next until one fails.",
  },
] satisfies Rule[];

// biome-ignore-all lint/style/useNamingConvention: the gate reads JSON fields like application_id
// The eval runner. The gate starts it inside the desk's own image, so the code under test is the
// code you ship. It runs the agent once for each application, as a dry run, and prints one line
// of JSON for each: the decision the agent would have written.
//   bun src/evals.ts HDC-2026-0142 HDC-2026-0143
import { newRun, runAgent } from "./agent";
import { DRY_RUN } from "./config";
import type { Message } from "./model";
import { provider } from "./telemetry";

type DecisionArguments = { status?: string; missing_items?: string[]; letter?: string };

// The decision is the arguments of the agent's last write_decision call.
function decisionIn(messages: Message[]): DecisionArguments | null {
  const toolCalls = messages.flatMap((message) => message.tool_calls ?? []);
  const writes = toolCalls.filter((call) => call.function.name === "write_decision");
  const lastWrite = writes.at(-1);
  if (!lastWrite) return null;
  return JSON.parse(lastWrite.function.arguments) as DecisionArguments;
}

async function evaluate(applicationId: string) {
  const run = newRun(applicationId, crypto.randomUUID());
  let runStatus = "unknown";
  for await (const event of runAgent(run)) {
    if (event.type === "done") runStatus = event.status;
  }
  const decision = decisionIn(run.messages);
  return {
    application_id: applicationId,
    run_status: runStatus,
    status: decision?.status ?? null,
    missing_items: decision?.missing_items ?? [],
    letter: decision?.letter ?? "",
  };
}

// A real run would write to the register and send a letter, so the runner refuses to start.
if (!DRY_RUN) {
  console.error("The eval runner only runs as a dry run. Start it with DRY_RUN=1.");
  process.exit(2);
}
for (const applicationId of process.argv.slice(2)) {
  console.log(JSON.stringify(await evaluate(applicationId)));
}
await provider.forceFlush();

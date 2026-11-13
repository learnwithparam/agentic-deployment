// biome-ignore-all lint/style/useNamingConvention: the desk JSON uses names like application_id
// rate-limit-residents: one resident who reloads the page again and again gets a 429 with
// Retry-After, while every other resident is still served. The check reads only status codes
// and headers, and it stops reading each stream as soon as the answer starts.
import type { Rule } from "../scripts/verify";
import { startDesk } from "./lib/desk";
import { resetWorld, URLS } from "./lib/world";

/** The status code and Retry-After header of one request to start a run. */
type Answer = { status: number; retryAfter: string | null; errorCode: unknown };

async function errorCodeOf(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: unknown } };
  return body.error?.code;
}

async function startRun(headers: Record<string, string>): Promise<Answer> {
  const response = await fetch(`${URLS.desk}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ application_id: "HDC-2026-0142" }),
  });
  const answer = {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    errorCode: null as unknown,
  };
  if (response.status === 429) answer.errorCode = await errorCodeOf(response);
  // Only the start of the answer matters here, so stop reading the stream.
  else await response.body?.cancel();
  return answer;
}

async function sixRequests(headers: Record<string, string>): Promise<Answer[]> {
  const answers: Answer[] = [];
  for (let i = 0; i < 6; i++) answers.push(await startRun(headers));
  return answers;
}

/** Who asked, and what they got back. */
type Scenario = { first: Answer[]; second: Answer; byAddress: Answer[] };

async function playScenario(started: ReturnType<typeof startDesk>): Promise<Scenario | null> {
  if (!(await started).ok) return null;
  await resetWorld();
  const tag = Date.now();
  const first = await sixRequests({ "x-resident-id": `resident-a-${tag}` });
  const second = await startRun({ "x-resident-id": `resident-b-${tag}` });
  const byAddress = await sixRequests({ "x-forwarded-for": `203.0.113.${tag % 250}, 10.0.0.1` });
  return { first, second, byAddress };
}

// One scenario per started desk, and every rule below reads it.
const scenarios = new WeakMap<object, Promise<Scenario | null>>();
function scenario(dir: string): Promise<Scenario | null> {
  const started = startDesk(dir);
  let played = scenarios.get(started);
  if (!played) {
    played = playScenario(started);
    scenarios.set(started, played);
  }
  return played;
}

const statusesOf = (answers: Answer[] = []) => answers.map((answer) => answer.status).join(",");
const FIVE_THEN_REFUSED = "200,200,200,200,200,429";

function waitsSensibly(answer: Answer | undefined): boolean {
  const seconds = Number(answer?.retryAfter);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 10;
}

export default [
  {
    says: "6 runs from one resident (x-resident-id) inside 10 seconds: 5 start, the 6th gets 429",
    test: async (dir) => statusesOf((await scenario(dir))?.first) === FIVE_THEN_REFUSED,
    tryNext:
      "Before you open the stream, count the resident's runs in the last 10 seconds." +
      " At 5, answer 429 instead of starting a run.",
  },
  {
    says: "the 429 has a Retry-After header in whole seconds and the error code rate_limited",
    test: async (dir) => {
      const refused = (await scenario(dir))?.first.at(-1);
      return waitsSensibly(refused) && refused?.errorCode === "rate_limited";
    },
    tryNext:
      'Set context.header("Retry-After", String(seconds)) and answer' +
      ' { error: { code: "rate_limited", message } } with status 429.',
  },
  {
    says: "another resident in the same 10 seconds still gets 200",
    test: async (dir) => (await scenario(dir))?.second.status === 200,
    tryNext:
      "Keep one list of start times per resident, in a Map keyed by the resident," +
      " not one list for the whole desk.",
  },
  {
    says: "a resident with no x-resident-id is known by the first address in x-forwarded-for",
    test: async (dir) => statusesOf((await scenario(dir))?.byAddress) === FIVE_THEN_REFUSED,
    tryNext:
      'When there is no x-resident-id, use x-forwarded-for.split(",")[0].trim()' +
      " as the resident.",
  },
] satisfies Rule[];

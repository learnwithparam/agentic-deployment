// A limit per resident: each resident may start a few runs in each window of time.
// A resident who reloads the page twenty times starts five runs, not twenty.

// Five runs in each window of ten seconds, unless the environment says otherwise.
const RUNS_PER_WINDOW = Number(process.env.RATE_LIMIT_RUNS ?? 5);
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000);

// The start times of each resident's recent runs, by resident.
const recentRunStarts = new Map<string, number[]>();

/** How many seconds the resident must wait, or 0 when they may start a run now. */
export function secondsToWait(resident: string): number {
  const now = Date.now();
  const earlierStarts = recentRunStarts.get(resident) ?? [];
  const recent = earlierStarts.filter((startTime) => now - startTime < WINDOW_MS);
  if (recent.length >= RUNS_PER_WINDOW) {
    recentRunStarts.set(resident, recent);
    const oldestStart = recent[0];
    return Math.ceil((WINDOW_MS - (now - oldestStart)) / 1000);
  }
  recent.push(now);
  recentRunStarts.set(resident, recent);
  return 0;
}

/** A resident is the x-resident-id header, else the first address in x-forwarded-for. */
export function residentOf(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  const firstAddress = forwardedFor?.split(",")[0].trim();
  return headers.get("x-resident-id") ?? firstAddress ?? "local";
}

// hold-the-latency-goal: runs wait in a queue. No run waits longer than the goal, and a run that
// would is refused at once with too_busy. This check needs no Docker.
import { join } from "node:path";
import type { Rule } from "../scripts/verify";

type Limits = { maxRunning: number; maxWaiting: number; maxWaitMs: number };
type Queue = { submit: <Result>(job: () => Promise<Result>) => Promise<Result> };
type CreateQueue = (limits: Limits) => Queue;
type Refusal = { code?: string; retryAfterSeconds?: number };

async function load(dir: string): Promise<CreateQueue> {
  const loaded = await import(join(dir, "src", "queue.ts"));
  return loaded.createQueue;
}

// What a refused run threw, or undefined when it was not refused.
async function refusalOf(promise: Promise<unknown>): Promise<Refusal | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error as Refusal;
  }
}

export default [
  {
    says: "no more runs than maxRunning go at the same time, and all of them finish",
    test: async (dir) => {
      const queue = (await load(dir))({ maxRunning: 2, maxWaiting: 10, maxWaitMs: 5000 });
      let now = 0;
      let peak = 0;
      const job = async () => {
        now += 1;
        peak = Math.max(peak, now);
        await Bun.sleep(30);
        now -= 1;
        return "done";
      };
      const answers = await Promise.all(Array.from({ length: 6 }, () => queue.submit(job)));
      return peak === 2 && answers.every((answer) => answer === "done");
    },
    tryNext: "Count the runs now going. Start a new one only when the count is below maxRunning.",
  },
  {
    says: "waiting runs start in the order they came",
    test: async (dir) => {
      const queue = (await load(dir))({ maxRunning: 1, maxWaiting: 10, maxWaitMs: 5000 });
      const started: number[] = [];
      const jobFor = (number: number) => async () => {
        started.push(number);
        await Bun.sleep(20);
      };
      await Promise.all([1, 2, 3, 4].map((number) => queue.submit(jobFor(number))));
      return started.join(",") === "1,2,3,4";
    },
    tryNext: "Keep the waiting runs in a list. Take the first one when a slot frees.",
  },
  {
    says: "when the waiting line is full, the next run is refused at once with too_busy",
    test: async (dir) => {
      const queue = (await load(dir))({ maxRunning: 1, maxWaiting: 1, maxWaitMs: 5000 });
      const slow = () => Bun.sleep(300);
      const first = queue.submit(slow);
      const second = queue.submit(slow);
      const started = Date.now();
      const refusal = await refusalOf(queue.submit(slow));
      const quick = Date.now() - started < 100;
      await Promise.all([first, second]);
      return refusal?.code === "too_busy" && quick;
    },
    tryNext: "Before you wait, check the waiting count. At maxWaiting, throw TooBusy at once.",
  },
  {
    says: "a run that waits longer than maxWaitMs is refused, and it never starts",
    test: async (dir) => {
      const queue = (await load(dir))({ maxRunning: 1, maxWaiting: 10, maxWaitMs: 150 });
      let secondStarted = false;
      const first = queue.submit(() => Bun.sleep(500));
      const started = Date.now();
      const second = refusalOf(
        queue.submit(async () => {
          secondStarted = true;
        }),
      );
      const refusal = await second;
      const waited = Date.now() - started;
      await first;
      return refusal?.code === "too_busy" && waited < 400 && !secondStarted;
    },
    tryNext: "Start a timer of maxWaitMs when a run waits. When it fires, remove and refuse it.",
  },
  {
    says: "a refusal says when to try again, in whole seconds of at least 1",
    test: async (dir) => {
      const queue = (await load(dir))({ maxRunning: 1, maxWaiting: 0, maxWaitMs: 200 });
      const first = queue.submit(() => Bun.sleep(100));
      const refusal = await refusalOf(queue.submit(() => Bun.sleep(1)));
      await first;
      const seconds = refusal?.retryAfterSeconds ?? 0;
      return Number.isInteger(seconds) && seconds >= 1;
    },
    tryNext: "Give TooBusy a retryAfterSeconds that is a whole number, never less than 1.",
  },
  {
    says: "a run that throws frees its slot, so the next run still starts",
    test: async (dir) => {
      const queue = (await load(dir))({ maxRunning: 1, maxWaiting: 5, maxWaitMs: 2000 });
      const broken = refusalOf(
        queue.submit(async () => {
          await Bun.sleep(20);
          throw new Error("the model failed");
        }),
      );
      const next = queue.submit(async () => "still works");
      await broken;
      return (await next) === "still works";
    },
    tryNext: "Free the slot in a finally block, so it runs whether the job worked or threw.",
  },
] satisfies Rule[];

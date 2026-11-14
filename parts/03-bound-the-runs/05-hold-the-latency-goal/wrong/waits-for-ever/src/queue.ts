// Wrong: a run waits for ever. Nothing refuses it, so the latency goal is never kept.
export class TooBusy extends Error {
  code = "too_busy";
  constructor(public retryAfterSeconds: number) {
    super(`too_busy: try again in ${retryAfterSeconds} seconds`);
  }
}

export type QueueLimits = {
  maxRunning: number; // runs allowed at the same time
  maxWaiting: number; // runs allowed to wait for a slot
  maxWaitMs: number; // the latency goal: no run waits longer than this to start
};

type Waiter = { start: () => void; refuse: () => void };

export function createQueue(limits: QueueLimits) {
  let running = 0;
  const waiting: Waiter[] = [];
  const retryAfterSeconds = Math.max(1, Math.ceil(limits.maxWaitMs / 1000));

  function startNext() {
    const next = waiting.shift();
    if (next) next.start();
  }

  async function run<Result>(job: () => Promise<Result>): Promise<Result> {
    try {
      return await job();
    } finally {
      running -= 1;
      startNext();
    }
  }

  function wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          running += 1;
          resolve();
        },
        refuse: () => reject(new TooBusy(retryAfterSeconds)),
      };
      waiting.push(waiter);
    });
  }

  return {
    submit: async <Result>(job: () => Promise<Result>): Promise<Result> => {
      if (running < limits.maxRunning) {
        running += 1;
        return run(job);
      }
      await wait();
      return run(job);
    },
  };
}

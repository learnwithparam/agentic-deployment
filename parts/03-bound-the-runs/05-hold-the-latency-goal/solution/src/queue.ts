// A queue for runs. It limits runs at the same time, and refuses a run that would wait too long.
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
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.refuse();
      }, limits.maxWaitMs);
      const waiter: Waiter = {
        start: () => {
          clearTimeout(timer);
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
      if (waiting.length >= limits.maxWaiting) throw new TooBusy(retryAfterSeconds);
      await wait();
      return run(job);
    },
  };
}

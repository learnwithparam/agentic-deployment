// A queue for runs. Today every run starts at once, so a rush asks the model for too much at once.
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

export function createQueue(_limits: QueueLimits) {
  return {
    submit: <Result>(job: () => Promise<Result>): Promise<Result> => job(),
  };
}

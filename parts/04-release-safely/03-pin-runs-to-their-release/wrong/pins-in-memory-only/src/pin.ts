// Wrong: it pins runs in a private map, so a restart forgets them.
export type Weights = Record<string, number>;
export type Router = {
  setWeights: (weights: Weights) => void;
  releaseFor: (runId: string) => string;
  finish: (runId: string) => void;
};

// pick() gives a number from 0 up to, but not including, 1.
export function createRouter(_store: Map<string, string>, pick: () => number): Router {
  const remembered = new Map<string, string>();
  let weights: Weights = {};
  const choose = (): string => {
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    let point = pick() * total;
    for (const [release, weight] of Object.entries(weights)) {
      if (point < weight) return release;
      point -= weight;
    }
    return Object.keys(weights)[0];
  };
  return {
    setWeights: (next) => {
      weights = next;
    },
    releaseFor: (runId) => {
      const pinned = remembered.get(runId);
      if (pinned) return pinned;
      const release = choose();
      remembered.set(runId, release);
      return release;
    },
    finish: (runId) => {
      remembered.delete(runId);
    },
  };
}

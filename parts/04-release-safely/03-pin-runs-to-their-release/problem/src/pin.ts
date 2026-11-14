// Choose a release for each run. Today every question picks again, so a run can change release.
export type Weights = Record<string, number>;
export type Router = {
  setWeights: (weights: Weights) => void;
  releaseFor: (runId: string) => string;
  finish: (runId: string) => void;
};

// pick() gives a number from 0 up to, but not including, 1.
export function createRouter(_store: Map<string, string>, pick: () => number): Router {
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
    releaseFor: () => choose(),
    finish: () => {},
  };
}

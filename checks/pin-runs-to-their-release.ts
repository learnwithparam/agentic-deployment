// pin-runs-to-their-release: a run that has started keeps its release, even when a canary
// changes the weights. This check needs no Docker.
import { join } from "node:path";
import type { Rule } from "../scripts/verify";

type Router = {
  setWeights: (weights: Record<string, number>) => void;
  releaseFor: (runId: string) => string;
  finish: (runId: string) => void;
};
type CreateRouter = (store: Map<string, string>, pick: () => number) => Router;

async function load(dir: string): Promise<CreateRouter> {
  const loaded = await import(join(dir, "src", "pin.ts"));
  return loaded.createRouter;
}

const CANARY_TEN_PERCENT = { v1: 90, v2: 10 };
const ALL_ON_V2 = { v1: 0, v2: 100 };

export default [
  {
    says: "a new run gets a release by the weights: 90 for v1 and 10 for v2",
    test: async (dir) => {
      const createRouter = await load(dir);
      const low = createRouter(new Map(), () => 0.5);
      low.setWeights(CANARY_TEN_PERCENT);
      const high = createRouter(new Map(), () => 0.95);
      high.setWeights(CANARY_TEN_PERCENT);
      return low.releaseFor("run-1") === "v1" && high.releaseFor("run-2") === "v2";
    },
    tryNext: "Walk the weights in order. Take the first release whose share holds the pick.",
  },
  {
    says: "a release with weight 0 is never chosen",
    test: async (dir) => {
      const createRouter = await load(dir);
      const router = createRouter(new Map(), () => 0.999);
      router.setWeights({ v1: 100, v2: 0 });
      return router.releaseFor("run-1") === "v1";
    },
    tryNext: "Check the starter's choose function. A weight of 0 must hold no part of the line.",
  },
  {
    says: "a run in flight keeps its release after the weights change",
    test: async (dir) => {
      const createRouter = await load(dir);
      const router = createRouter(new Map(), () => 0.1);
      router.setWeights(CANARY_TEN_PERCENT);
      const before = router.releaseFor("run-1");
      router.setWeights(ALL_ON_V2);
      return before === "v1" && router.releaseFor("run-1") === "v1";
    },
    tryNext: "In releaseFor, look in the store first. Choose and save only when the run is new.",
  },
  {
    says: "a run that starts after the change gets the new weights",
    test: async (dir) => {
      const createRouter = await load(dir);
      const router = createRouter(new Map(), () => 0.1);
      router.setWeights(CANARY_TEN_PERCENT);
      router.releaseFor("run-1");
      router.setWeights(ALL_ON_V2);
      return router.releaseFor("run-2") === "v2";
    },
    tryNext: "Only runs already in the store are pinned. A new run id must be chosen again.",
  },
  {
    says: "after a restart, a run keeps its release, because the pin lives in the store",
    test: async (dir) => {
      const createRouter = await load(dir);
      const store = new Map<string, string>();
      const first = createRouter(store, () => 0.1);
      first.setWeights(CANARY_TEN_PERCENT);
      first.releaseFor("run-1");
      const restarted = createRouter(store, () => 0.99);
      restarted.setWeights(ALL_ON_V2);
      return restarted.releaseFor("run-1") === "v1";
    },
    tryNext: "Keep the pins in the store you are given, not in a Map you make inside the router.",
  },
  {
    says: "a finished run is forgotten, so the store does not grow for ever",
    test: async (dir) => {
      const createRouter = await load(dir);
      const store = new Map<string, string>();
      const router = createRouter(store, () => 0.1);
      router.setWeights(CANARY_TEN_PERCENT);
      router.releaseFor("run-1");
      router.finish("run-1");
      return store.size === 0;
    },
    tryNext: "In finish, delete the run id from the store.",
  },
] satisfies Rule[];

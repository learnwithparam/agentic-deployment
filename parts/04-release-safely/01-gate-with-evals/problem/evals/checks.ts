// biome-ignore-all lint/style/useNamingConvention: case files use JSON names like missing_items
// The gate's code checks. Each one compares the decision the agent would write with the answer
// the council's rules give. Code checks are cheap, exact and give the same answer on every run,
// so a gate runs them first.

/** One fixed application from evals/cases.json, with the answer the council's rules give. */
export type EvalCase = {
  application_id: string;
  status: string;
  missing_items: string[];
  fee_owed_gbp: number;
};

/** What the agent would have written for one application, from the eval runner. */
export type Decision = {
  application_id: string;
  run_status: string;
  status: string | null;
  missing_items: string[];
  letter: string;
};

/** Every way this decision is wrong, as short sentences. An empty list means the case passes. */
export function findProblems(evalCase: EvalCase, decision: Decision): string[] {
  const problems: string[] = [];
  // TODO(you): add three code checks, and push a short sentence for each one that fails.
  //   1. The status is the case's status.
  //   2. The missing items are the case's missing items, in any order.
  //   3. When a fee is owed, the letter never tells the resident that no fee is needed.
  if (decision.application_id !== evalCase.application_id) {
    problems.push("this decision is for another application");
  }
  return problems;
}

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

// The status is the whole decision, so this checks only the status.
/** Every way this decision is wrong, as short sentences. An empty list means the case passes. */
export function findProblems(evalCase: EvalCase, decision: Decision): string[] {
  const problems: string[] = [];
  if (decision.application_id !== evalCase.application_id) {
    problems.push("this decision is for another application");
  }
  if (decision.status !== evalCase.status) {
    problems.push(`status is ${decision.status}, the rules say ${evalCase.status}`);
  }
  return problems;
}

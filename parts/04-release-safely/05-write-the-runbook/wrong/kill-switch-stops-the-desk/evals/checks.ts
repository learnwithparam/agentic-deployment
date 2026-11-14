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

// Ways a letter can tell a resident they need not pay. Only wrong when a fee is owed.
const NO_FEE_WORDING = /no fee is (needed|due|required)|fee is not (needed|due|required)/i;

// Two lists hold the same items when they match after sorting, so the order does not matter.
function sameItems(first: string[], second: string[]): boolean {
  const firstSorted = [...first].sort().join(",");
  const secondSorted = [...second].sort().join(",");
  return firstSorted === secondSorted;
}

/** Every way this decision is wrong, as short sentences. An empty list means the case passes. */
export function findProblems(evalCase: EvalCase, decision: Decision): string[] {
  const problems: string[] = [];
  if (decision.application_id !== evalCase.application_id) {
    problems.push("this decision is for another application");
  }
  if (decision.status !== evalCase.status) {
    problems.push(`status is ${decision.status}, the rules say ${evalCase.status}`);
  }
  if (!sameItems(decision.missing_items, evalCase.missing_items)) {
    const asked = decision.missing_items.join(", ") || "nothing";
    problems.push(`asks for ${asked}, the rules say ${evalCase.missing_items.join(", ")}`);
  }
  const feeOwed = evalCase.fee_owed_gbp > 0;
  if (feeOwed && NO_FEE_WORDING.test(decision.letter)) {
    problems.push(`the letter says no fee is needed, but £${evalCase.fee_owed_gbp} is owed`);
  }
  return problems;
}

import { readArtefact, runCapstoneCheck } from "../../../../checks/capstone";

runCapstoneCheck([
  {
    says: "plan.md has a line that starts with Outcome:",
    test: (artefact) => /^Outcome: .+/m.test(readArtefact(artefact, "plan.md")),
    tryNext: "add a line like: Outcome: the baker sees tomorrow's orders before 6",
  },
]);

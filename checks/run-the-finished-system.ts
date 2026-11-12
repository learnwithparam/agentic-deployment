import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";

const file = (d: string) => join(d, "outcome.md");
export default [
  { says: "outcome.md exists", test: (d) => existsSync(file(d)), tryNext: "create outcome.md in the problem folder" },
  {
    says: "it has a line that starts with Outcome:",
    test: (d) => /^Outcome: .+/m.test(readFileSync(file(d), "utf8")),
    tryNext: "add a line like: Outcome: the manager sees every late delivery before 9 am",
  },
] satisfies Rule[];

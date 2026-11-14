// bun capstone/check.ts <folder>: judge your own agent's release folder.
// It reads only the folder you give it, never the course world.
import { runCapstoneCheck } from "../checks/capstone";
import rules from "../checks/deploy-your-own-agent";

const folderRules = rules.map((rule) => ({
  says: rule.says,
  test: (folder: string) => Boolean(rule.test(folder)),
  tryNext: rule.tryNext,
}));

runCapstoneCheck(folderRules);

// roll-back-automatically: a bad canary is set to 0% by an alert, with no one at the keyboard,
// and a good canary is left alone.
import {
  alertFiresFor,
  canaryDrill,
  type Drill,
  setDeskBudget,
  startStack,
} from "../parts/04-release-safely/release-stack";
import type { Rule } from "../scripts/verify";
import { URLS } from "./lib/world";

const SERVICES = ["traefik", "desk-stable", "desk-canary", "controller", "prometheus"];
const THREE_MINUTES = 180;
type PrometheusRule = { type: string; query: string };
type RuleGroups = { data: { groups: { rules: PrometheusRule[] }[] } };
type Drills = { good: Drill; bad: Drill; badAlertFired: boolean } | null;

/** Alert rules Prometheus has loaded that read the register's judgement of decisions. */
async function registerAlertRules(): Promise<PrometheusRule[]> {
  const response = await fetch(`${URLS.prometheus}/api/v1/rules`);
  const answer = (await response.json()) as RuleGroups;
  const rules = answer.data.groups.flatMap((group) => group.rules);
  return rules.filter(
    (rule) => rule.type === "alerting" && rule.query.includes("register_decisions_total"),
  );
}

async function hasAlertRule(dir: string): Promise<boolean> {
  if (!(await startStack(dir, SERVICES)).ok) return false;
  return (await registerAlertRules()).length > 0;
}

// The good release first, then the bad one, so the bad one's rollback is the last thing seen.
async function runDrills(dir: string): Promise<Drills> {
  if (!(await hasAlertRule(dir))) return null;
  await setDeskBudget(10);
  const good = await canaryDrill("v3", 20);
  const bad = await canaryDrill("v2", THREE_MINUTES);
  const badAlertFired = await alertFiresFor("v2");
  await setDeskBudget(2);
  return { good, bad, badAlertFired };
}

// The drills run once per folder, and every rule below reads the same results.
const drillsByFolder = new Map<string, Promise<Drills>>();
function drills(dir: string): Promise<Drills> {
  let result = drillsByFolder.get(dir);
  if (!result) {
    result = runDrills(dir);
    drillsByFolder.set(dir, result);
  }
  return result;
}

export default [
  {
    says: "Prometheus has loaded an alert rule that reads register_decisions_total",
    test: hasAlertRule,
    tryNext:
      "Add a rule to prometheus/alerts.yml, then open http://localhost:9090/rules." +
      " A YAML mistake shows in docker compose logs prometheus.",
  },
  {
    says: "release v2 on a 10% canary is set to 0% within 3 minutes, with no key pressed",
    test: async (dir) => {
      const bad = (await drills(dir))?.bad;
      return bad?.weightAtEnd === 0 && bad.seconds < THREE_MINUTES;
    },
    tryNext:
      "Send the alert to the controller: a webhook receiver with the url" +
      " http://controller:7010/alert. Inside a container, localhost is the container itself.",
  },
  {
    says: "the alert fired in Prometheus with the label release=v2",
    test: async (dir) => Boolean((await drills(dir))?.badAlertFired),
    tryNext:
      'Write the rule with "sum by (release)", so each alert carries its release.' +
      " Without that label the controller cannot tell which release to roll back.",
  },
  {
    says: "the controller's audit log holds the rollback, with the alert's name and release v2",
    test: async (dir) => {
      const rollback = (await drills(dir))?.bad.rollback;
      return rollback?.release === "v2" && typeof rollback.alert === "string";
    },
    tryNext: "Read http://localhost:7010/state. A rollback entry appears once the webhook works.",
  },
  {
    says: "release v3 on a 10% canary is still at 10% after 20 seconds of traffic",
    test: async (dir) => {
      const good = (await drills(dir))?.good;
      return good !== undefined && good.weightAtEnd === 10 && !good.rollback;
    },
    tryNext:
      "Alert on the share of decisions the rules disagree with, not on the number of decisions." +
      ' Divide the agrees="no" count by the total, by release.',
  },
] satisfies Rule[];

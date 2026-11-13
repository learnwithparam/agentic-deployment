# Runbook: the permit desk

Use this page when an alert about the permit desk fires. Work from the top of the repo.

## Symptoms

- The alert `ReleaseDisagreesWithRules` fires. A release writes decisions that the council's rules do not
  agree with.
- Residents get letters that ask for the wrong things, or that say no fee is needed when a fee is owed.
- The release controller at http://localhost:7010/state shows a rollback you did not start.

## First five minutes

1. Open http://localhost:9090/alerts. Note which release the alert names.
2. Open http://localhost:7010/state. Check that the canary weight is 0.
3. Open http://localhost:7004 and find a trace from that release. Read its last tool call.
4. If stable is wrong too, or you are not sure, use the kill switch below.

## Kill switch

The kill switch stops the desks. With no desk running, no letter goes out.

```bash
docker compose -p hdc-desk stop desk-stable desk-canary
```

Expect: `Container hdc-desk-desk-stable-1  Stopped`

## Roll back

The controller rolls a bad canary back on its own. To do it by hand, set the canary weight to 0:

```bash
curl -s localhost:7010/canary -H "content-type: application/json" -d '{"release":"v1","weight":0}'
```

Expect: `"canary_weight":0` in the answer.

## Who to tell

- Tom Reid, team lead, decides when the desk opens again.
- Priya Shah, budget holder, checks what the bad release spent.
- The planning team, who wrote the release, with the ids of the wrong letters.

## After

1. Find every letter the bad release sent: `curl -s localhost:7001/audit`, and look for its release id.
2. Write to each resident who got a wrong letter.
3. Add each wrong case to `evals/cases.json`, so the gate catches it next time.
4. Turn the model calls back on:

```bash
curl -s -X POST localhost:7002/admin/revive -H "authorization: Bearer $(cat secrets/gateway_admin_key)"
```

Expect: `{"killed":false}`

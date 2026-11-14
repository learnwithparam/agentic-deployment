# Runbook for my agent

## Kill switch

Run `docker compose stop agent`. The agent stops, so no model call is made.

## Roll back

Run `docker compose up -d` with release v1 in release.json. Then check the health answer.

## Who to tell

Tell the owner of the service in the team chat, and the person on call.

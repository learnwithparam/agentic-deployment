# How Claude Code got here

You wrote no calls by hand. You asked Claude Code for each of the six moves, tried each one on the emulator,
and kept only what you saw work.

## The prompts

First the Compose file and the key:

```text
Fill in docker-compose.yml with floci/floci-gcp:0.12.0, port 4588 and the Docker socket.
Then in release.ts write storeKey: create the secret desk-gateway-key in Secret Manager and
add the key from fake-key.txt as its first version. Use a fake key only.
```

Then the deploy, the call and the second revision:

```text
Write deploy, callDesk and ship in release.ts. Deploy creates the Cloud Run service desk
through the Cloud Run Admin API v2 and waits for desk-00001. Ship patches the template to
releases/v2.json and waits for desk-00002.
```

Last the rollback, with a test first:

```text
Before you write rollback, test on the running emulator: patch traffic to desk-00001, and
patch the template back. Tell me which one makes the desk answer v1. Then write rollback.
```

## What Claude Code showed

The traffic patch was accepted, but the desk still answered v2. Patching the template back made a new
revision, `desk-00003`, and it answered v1. So the rollback in `release.ts` is the template patch.

## What you checked

- The secret holds the fake key, and `release.ts` does not.
- Each revision answers with the release you expect.
- The rollback came from a real test, not from the docs alone.

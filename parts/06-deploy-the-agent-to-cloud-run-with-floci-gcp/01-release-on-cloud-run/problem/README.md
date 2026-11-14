# Release on Cloud Run

## The problem

Cloud Run keeps each change as a numbered revision, like `desk-00001`. For example, when the second release is bad, you need the first one back. You try that on floci-gcp, a free emulator of
Google Cloud. It needs no account or key.

## Watch it done

Before, the service has no revisions. After, the revisions look like this:

```text
desk-00001  v1  deploy
desk-00002  v2  ship
desk-00003  v1  rollback
```

```mermaid
flowchart LR
  A[deploy] --> B[call] --> C[ship] --> D[rollback]
```

## Your turn

Work in this `problem/` folder.

1. Build the desk image that the emulator will run.

```bash
docker build -t hdc-desk:cloud-run ../../../05-go-further/02-deploy-to-the-cloud/solution
```

Expect: `naming to docker.io/library/hdc-desk:cloud-run`

2. **Start the emulator.** Fill in `docker-compose.yml`, then run `docker compose up -d`.
3. **Store the key.** In `release.ts`, put the fake key from `fake-key.txt` in Secret Manager as
   `desk-gateway-key`. Never use a real key.
4. **Deploy.** Create the Cloud Run service `desk` from the image, with the first release.
5. **Call it.** `bun release.ts call` prints the desk's health answer.

```bash
docker compose up -d
bun release.ts deploy
bun release.ts call
```

Expect: `Deployed revision desk-00001.` and then `{"status":"ok","version":"v1"}`

6. **Ship.** Change the template to the second release. That makes revision `desk-00002`.
7. **Roll back.** Get the first release serving again. Try your idea on the emulator first. Believe only what you
   see it do.

```bash
bun release.ts ship
bun release.ts rollback
bun release.ts call
```

Expect: `Shipped revision desk-00002.`, then a rollback line, then `"version":"v1"` again.

8. Run the check, then stop the emulator.

```bash
bun run verify release-on-cloud-run
docker compose down -v
```

Expect: `Done. All 7 rules pass.`

The emulator cannot mount a secret as a file. So `release.ts` reads it from Secret Manager at deploy time and
passes it as a value. On real Cloud Run you would mount it.

## Do it on your work

Try the rollback of one service of your own on a safe copy. Good looks like a rollback you watched work.

## Done when

- `docker-compose.yml` runs the pinned `floci/floci-gcp` image on port 4588.
- The fake key is in Secret Manager, and only in `fake-key.txt` in your files.
- `desk-00001` serves the first release, and `call` prints that answer.
- `desk-00002` serves the second release.
- After the rollback, the first release serves again, and the service has three revisions.

## Solution

The after state is a filled-in `docker-compose.yml` and a `release.ts` with deploy, ship and rollback. See
`../solution/` for both and their diff.

## If you get stuck

- Hint: create a secret with `POST /v1/projects/floci-local/secrets?secretId=desk-gateway-key`. Then add a
  version with `:addVersion`. The key goes in `payload.data` as base64.
- Hint: create the service with `POST` on the `services?serviceId=desk` path under
  `/v2/projects/floci-local/locations/us-central1`. It is ready in about 5 seconds.
- Hint: a `GET` on `/run/v2/projects/floci-local/locations/us-central1/services/desk/healthz` calls the desk.
- Hint: a `PATCH` on the service path with a changed template makes a new revision.
- Go further: add a `status` command.
- If the rollback prints but the second release still serves, the emulator ignored it. Call the desk.

## Words you will use

- **Cloud Run**: a Google Cloud service that runs a container image and gives it an address.
- **Revision**: one saved copy of a service's template. Each change makes a new one.
- **Secret Manager**: the cloud's place for keys. Never keep a key in code.
- **Emulator**: a program on your machine that answers like a cloud service.

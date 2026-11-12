# Troubleshooting

Every message the course's commands print when something is wrong, what it means, and what to do.

| What you see | What it means | Fix |
|---|---|---|
| `Docker is not running.` | `bun run setup` could not reach the Docker daemon. | Start Docker Desktop, or `sudo systemctl start docker` on Linux, then run `bun run setup` again. |
| `Docker can use only N GB.` | Docker has less than 4 GB of memory. | Docker Desktop, Settings, Resources: raise memory to 4 GB or more. |
| `Docker Compose 2.24 or newer is needed.` | Your Compose cannot read optional env files. | Update Docker Desktop, or install the current Compose plugin. |
| `ports ... are in use by another program.` | Something else listens on a port the course uses. | Stop that program, or run `bun run down all` if it is an old copy of this course. |
| `docker compose could not start the world:` | A world container failed to build or start. The lines after it are Docker's own words. | Run `docker compose -f world/compose.yaml logs` and read the last lines. A `429 Too Many Requests` means Docker Hub is limiting pulls: sign in with `docker login`. |
| `The gateway has no admin key. Run bun run world first` | The gateway started without `secrets/gateway_admin_key`. | Run `bun run world`. It makes the secrets, then starts the services. |
| `The world is not running. Start it with: bun run world` | `bun run world status` found no services on ports 7001 to 7004. | Run `bun run world`. |
| `The finished desk did not start:` | One of the finished system's containers is unhealthy. | `docker compose -f world/finished/compose.yaml ps` shows which. Its logs: `docker compose -f world/finished/compose.yaml logs <service>`. |
| `Your desk did not start:` | `bun run up <step-name>` could not build or start your desk. | Read the lines after it, then `docker compose -p hdc-desk logs desk`. |
| `<folder> has no compose.yaml yet.` | The step folder has no Compose file. | Write `compose.yaml` in that step's `problem/` folder, as the step asks. |
| `There is no step called "..."` | The step name is misspelt. | The message lists every step. Copy one. |
| `Nothing answers on http://localhost:8080` | The finished desk is not running. | `bun run up finished`. |
| `Nothing answers on http://localhost:3000` | Your desk is not running. | `bun run up <step-name>`. |
| `The desk answered 4xx without a stream:` | `/v1/runs` answered with plain JSON or an error, not an event stream. | In `package-the-agent`, return `streamSSE(...)`. Otherwise read the JSON it printed. |
| `GATEWAY_KEY is empty, so every model call will be refused.` | The starter desk found no key in its environment. | Pass `GATEWAY_KEY: ${GATEWAY_ADMIN_KEY}` as a build argument (`package-the-agent`), or read the key file (`move-secrets-out`). |
| `The desk cannot start: its gateway key file /run/secrets/gateway_key is missing.` | The desk ran without its Compose secret. | List `gateway_key` under the desk service's `secrets:` and declare it at the top level with its `file:`. |
| `That gateway key is not known.` | The desk sent a key the gateway never issued. | Use `secrets/desk_gateway_key`. If you reset Docker volumes, run `bun run world` again to register the keys. |
| `The key "desk" has spent its budget of $2.` | The desk's gateway key reached its budget. | `bun run world reset` sets spend back to zero. In Part 3 you make the desk stop long before this. |
| `The gateway kill switch is on.` | Someone turned off all model calls at the gateway. | Run `bun run world reset`, which turns it back on. |
| `"..." is not a role. Ask for fast, smart or judge.` | The desk asked the gateway for a model id. | Ask for a role. Only `config/models.ts` names models. |
| `ANTHROPIC_API_KEY is not set` (or the OpenRouter or OpenAI name) | `LLM_PROVIDER` names a real provider with no key. | Put the key in `.env`, or set `LLM_PROVIDER=replay`. Restart the world after a change: `bun run world stop`, then `bun run world`. |
| `LLM_PROVIDER="..." is not one of replay, anthropic, openrouter, openai` | A typo in `.env`. | Use one of the four names. |
| `N role(s) failed. Check the key and LLM_PROVIDER in .env.` | `bun run models` could not reach a role. The line above it says why. | Fix the key or provider and run it again. |
| `Chaos runs only with LLM_PROVIDER=replay` | Chaos commands refuse to spend real money. | Set `LLM_PROVIDER=replay` in `.env` and restart the world. |
| `The run did not stop within 60 seconds.` | `bun run chaos runaway` hit a desk with no brakes. | That is the problem Part 3 solves. |
| `The desk never wrote a decision, so there was nothing to interrupt.` | `bun run chaos kill` saw no decision. | Check the desk works first: `bun run run-application HDC-2026-0142`. |
| `No rollback within 3 minutes` | `bun run chaos bad-canary` saw no automatic rollback. | Open http://localhost:9090/alerts and http://localhost:7010/state to see where the chain stopped. |
| `Send OTLP as JSON` (HTTP 415 from the trace desk) | Your exporter sends protobuf. | Use `@opentelemetry/exporter-trace-otlp-http`, which sends JSON. |
| `That username and password do not match.` | Wrong sign-in details on the council's sign-in page. | Passwords are in `secrets/passwords`. |
| `redirect_uri must be http://localhost:<port>/staff/callback` | The desk sent a callback the sign-in service does not allow. | Use `PUBLIC_URL` plus `/staff/callback`. |
| `Sign-in failed. Try again from /staff.` | The desk could not swap the code for a token. | The code is single use: start again from `/staff`. Check `secrets/desk_client_secret` is mounted. |
| `FAIL ...` then `Try next: ...` | A rule in `bun run verify` failed. | Do what the Try next line says, then run the check again. |
| `ERROR the check for <step> could not load` | The check file itself failed to run. | Run `bun install`, then try again. If it persists, it is a course bug: report it. |
| `The repo does not meet the standard.` | `bun run check` found a course rule broken. | Each line names the file and the rule. |

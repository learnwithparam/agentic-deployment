// Release the permit desk on Cloud Run, as emulated by floci-gcp.
// Run: bun release.ts deploy | call | ship | rollback
import { readFileSync } from "node:fs";

const EMULATOR = process.env.EMULATOR_URL ?? "http://localhost:4588";
const PARENT = "projects/floci-local/locations/us-central1";
const SERVICE = "desk";
const SECRET = "projects/floci-local/secrets/desk-gateway-key";
const IMAGE = "hdc-desk:cloud-run";

type ApiAnswer = {
  latestReadyRevision?: string;
  payload?: { data: string };
  [field: string]: unknown;
};

async function callApi(method: string, path: string, body?: object): Promise<ApiAnswer> {
  const response = await fetch(`${EMULATOR}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return JSON.parse(text);
}

// A Cloud Run service body. The release file picks the release; the image stays the same.
// The emulator cannot mount a secret, so the key goes in as a value.
// The desk writes it to a file, which is where it reads its key.
function serviceBody(releaseFile: string, key: string) {
  const startDesk = 'printf %s "$GATEWAY_KEY" > /tmp/gateway_key; exec bun src/server.ts';
  const environment = [
    { name: "GATEWAY_KEY", value: key },
    { name: "GATEWAY_KEY_FILE", value: "/tmp/gateway_key" },
    { name: "RELEASE_FILE", value: releaseFile },
  ];
  const container = {
    image: IMAGE,
    ports: [{ containerPort: 3000 }],
    command: ["sh", "-c"],
    args: [startDesk],
    env: environment,
  };
  return { template: { containers: [container] } };
}

async function waitForRevision(revision: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const service = await callApi("GET", `/v2/${PARENT}/services/${SERVICE}`);
    if (String(service.latestReadyRevision ?? "").endsWith(`/${revision}`)) return;
    await Bun.sleep(1000);
  }
  throw new Error(`The revision ${revision} was not ready after 60 seconds.`);
}

async function readKeyFromSecretManager(): Promise<string> {
  const version = await callApi("GET", `/v1/${SECRET}/versions/latest:access`);
  return Buffer.from(version.payload?.data ?? "", "base64").toString("utf8");
}

async function storeKey(): Promise<void> {
  const fakeKey = readFileSync("fake-key.txt", "utf8").trim();
  await callApi("POST", "/v1/projects/floci-local/secrets?secretId=desk-gateway-key", {
    replication: { automatic: {} },
  });
  const data = Buffer.from(fakeKey).toString("base64");
  await callApi("POST", `/v1/${SECRET}:addVersion`, { payload: { data } });
}

async function deploy(): Promise<void> {
  await storeKey();
  const key = await readKeyFromSecretManager();
  const body = serviceBody("releases/v1.json", key);
  await callApi("POST", `/v2/${PARENT}/services?serviceId=${SERVICE}`, body);
  await waitForRevision(`${SERVICE}-00001`);
  console.log("Deployed revision desk-00001.");
}

async function callDesk(): Promise<void> {
  const answer = await callApi("GET", `/run/v2/${PARENT}/services/${SERVICE}/healthz`);
  console.log(JSON.stringify(answer));
}

async function ship(): Promise<void> {
  const key = await readKeyFromSecretManager();
  const body = serviceBody("releases/v2.json", key);
  await callApi("PATCH", `/v2/${PARENT}/services/${SERVICE}`, body);
  await waitForRevision(`${SERVICE}-00002`);
  console.log("Shipped revision desk-00002.");
}

// The emulator accepts a traffic setting but does not apply it. A new revision from the old
// template is the rollback that works.
async function rollback(): Promise<void> {
  const key = await readKeyFromSecretManager();
  const body = serviceBody("releases/v1.json", key);
  await callApi("PATCH", `/v2/${PARENT}/services/${SERVICE}`, body);
  await waitForRevision(`${SERVICE}-00003`);
  console.log("Rolled back with revision desk-00003.");
}

const commands: Record<string, () => Promise<void>> = {
  deploy,
  call: callDesk,
  ship,
  rollback,
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.log("Use one of: deploy, call, ship, rollback.");
  process.exit(2);
}
await command();

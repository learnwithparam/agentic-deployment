// Release the permit desk on Cloud Run, as emulated by floci-gcp.
// Run: bun release.ts deploy | call | ship | rollback
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
// The emulator cannot mount a secret, so the key is passed as a value and the desk writes it to a file.
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

// Step 2: put the fake key from fake-key.txt in Secret Manager.
async function storeKey(): Promise<void> {
  // TODO(you): POST /v1/projects/floci-local/secrets?secretId=desk-gateway-key,
  // then POST /v1/projects/floci-local/secrets/desk-gateway-key:addVersion with the key as base64.
  throw new Error("storeKey is not written yet.");
}

// Step 3: store the key, read it back, then create the Cloud Run service.
async function deploy(): Promise<void> {
  await storeKey();
  const key = await readKeyFromSecretManager();
  const body = serviceBody("releases/v1.json", key);
  console.log("The service body is ready:", JSON.stringify(body));
  // TODO(you): POST the body to /v2/<parent>/services?serviceId=desk.
  await waitForRevision(`${SERVICE}-00001`);
  console.log("Deployed revision desk-00001.");
}

// Step 4: call the service through the emulator and print what it answers.
async function callDesk(): Promise<void> {
  // TODO(you): GET /run/v2/<parent>/services/desk/healthz and print the answer.
  throw new Error("call is not written yet.");
}

// Step 5: ship a second revision. The image stays; the release file changes.
async function ship(): Promise<void> {
  // TODO(you): PATCH the service with serviceBody("releases/v2.json", key), then wait for desk-00002.
  throw new Error("ship is not written yet.");
}

// Step 6: roll back. Test what the emulator really does before you trust it.
async function rollback(): Promise<void> {
  // TODO(you): put release v1 back in service, then wait for the new revision.
  throw new Error("rollback is not written yet.");
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

// biome-ignore-all lint/style/useNamingConvention: OAuth fields stay snake_case, like access_token
// Harrowby's sign-in service: a small OpenID Connect provider with the council's staff and
// residents. It issues signed tokens (RS256) with a "roles" claim. Your service checks them; it
// never sees a password. Grants: authorization_code (staff in a browser), client_credentials (a
// service identity), password (scripts).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";

const PORT = Number(process.env.PORT ?? 7003);
const ISSUER = process.env.ISSUER ?? `http://localhost:${PORT}`;
const DIR = process.env.IDP_DATA ?? "/data";
const SECRETS = process.env.SECRETS_DIR ?? "/run/secrets";
const DATA = process.env.WORLD_DATA ?? join(import.meta.dir, "..", "data");
const AUDIENCE = "permit-desk";
mkdirSync(DIR, { recursive: true });

type Person = { username: string; name: string; roles: string[] };
type Client = { secret: string; roles: string[] };
type SigningKey = { privateKey: CryptoKey; publicJwk: JWK };
type AuthorizationCode = {
  username: string;
  clientId: string;
  redirectUri: string;
  nonce?: string;
  expiresAt: number;
};

function readSecret(name: string): string | null {
  const file = join(SECRETS, name);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

const peopleFile = readFileSync(join(DATA, "people.json"), "utf8");
const people: Person[] = JSON.parse(peopleFile).people;
const passwords: Record<string, string> = JSON.parse(readSecret("passwords") ?? "{}");
const clients: Record<string, Client> = {
  "permit-desk": { secret: readSecret("desk_client_secret") ?? "", roles: ["agent"] },
};
const codes = new Map<string, AuthorizationCode>();

// One signing key, kept across restarts so tokens stay valid.
async function loadOrMakeSigningKey(): Promise<SigningKey> {
  const keyFile = join(DIR, "signing-key.json");
  if (existsSync(keyFile)) {
    const saved = JSON.parse(readFileSync(keyFile, "utf8"));
    const privateKey = (await importJWK(saved.private, "RS256")) as CryptoKey;
    return { privateKey, publicJwk: saved.public };
  }
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: randomBytes(6).toString("hex"),
    alg: "RS256",
    use: "sig",
  };
  const privateJwk = await exportJWK(keyPair.privateKey);
  writeFileSync(keyFile, JSON.stringify({ private: privateJwk, public: publicJwk }));
  return { privateKey: keyPair.privateKey, publicJwk };
}

const signingKey = await loadOrMakeSigningKey();

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

type TokenFor = { subject: string; name: string; roles: string[]; nonce?: string };

function signToken({ subject, name, roles, nonce }: TokenFor) {
  const claims = { name, roles, ...(nonce ? { nonce } : {}) };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: signingKey.publicJwk.kid })
    .setIssuer(ISSUER)
    .setSubject(subject)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey.privateKey);
}

const PAGE_STYLE = `body{font:16px system-ui;background:#f6f5f1;color:#1d1d1b;display:grid;
place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:32px;border-radius:10px;box-shadow:0 2px 12px #0002;width:320px;
box-sizing:border-box;max-width:100%}
h1{font-size:20px;margin:0 0 4px}
p{color:#555;margin:0 0 20px;font-size:14px}label{display:block;font-size:14px;margin:12px 0 4px}
input{width:100%;padding:8px;box-sizing:border-box;font:inherit}
button{margin-top:20px;width:100%;padding:10px;background:#1f4e3d;color:#fff;border:0;
border-radius:6px;font:inherit;cursor:pointer}.e{color:#a33}`;

function signInPage(query: URLSearchParams, error = ""): Response {
  const hiddenFields = [...query].map(([name, value]) => {
    const safeValue = value.replace(/"/g, "&quot;");
    return `<input type="hidden" name="${name}" value="${safeValue}">`;
  });
  const errorLine = error ? `<p class="e">${error}</p>` : "";
  const page = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Sign in: Harrowby District Council</title>
<style>${PAGE_STYLE}</style>
<form method="post" action="/authorize"><h1>Harrowby District Council</h1>
<p>Staff sign-in for the permit desk</p>
${errorLine}${hiddenFields.join("")}
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password">
<button>Sign in</button></form>`;
  return new Response(page, { headers: { "content-type": "text/html" } });
}

const redirectAllowed = (uri: string) =>
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/staff\/callback$/.test(uri);

function personWithPassword(username: string | null, password: string | null) {
  const person = people.find((candidate) => candidate.username === username);
  if (!person || !passwords[person.username]) return undefined;
  return passwords[person.username] === password ? person : undefined;
}

/** The client's id and secret, from HTTP Basic auth or from the form. */
function clientCredentials(request: Request, form: URLSearchParams) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    const [id, secret] = atob(authorization.slice(6)).split(":");
    return { id: decodeURIComponent(id), secret: decodeURIComponent(secret ?? "") };
  }
  return { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };
}

function discovery(): Response {
  return json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials", "password"],
    id_token_signing_alg_values_supported: ["RS256"],
    subject_types_supported: ["public"],
  });
}

function showSignIn(url: URL): Response {
  const query = url.searchParams;
  if (!clients[query.get("client_id") ?? ""]) {
    return oauthError("unauthorized_client", "unknown client_id");
  }
  if (!redirectAllowed(query.get("redirect_uri") ?? "")) {
    const description = "redirect_uri must be http://localhost:<port>/staff/callback";
    return oauthError("invalid_request", description);
  }
  return signInPage(query);
}

async function signIn(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const person = personWithPassword(form.get("username"), form.get("password"));
  if (!person) {
    // Show the form again, keeping the OAuth fields but never the password.
    const keptFields = [...form].filter(([name]) => !["username", "password"].includes(name));
    return signInPage(new URLSearchParams(keptFields), "That username and password do not match.");
  }
  const redirectUri = form.get("redirect_uri") ?? "";
  if (!redirectAllowed(redirectUri)) return oauthError("invalid_request", "bad redirect_uri");
  const code = randomBytes(16).toString("hex");
  codes.set(code, {
    username: person.username,
    clientId: form.get("client_id") ?? "",
    redirectUri,
    nonce: form.get("nonce") ?? undefined,
    expiresAt: Date.now() + 60_000,
  });
  const destination = new URL(redirectUri);
  destination.searchParams.set("code", code);
  const state = form.get("state");
  if (state) destination.searchParams.set("state", state);
  return Response.redirect(destination.toString(), 302);
}

async function tokenForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    return new URLSearchParams((await request.json()) as Record<string, string>);
  }
  return new URLSearchParams(await request.text());
}

async function passwordGrant(form: URLSearchParams): Promise<Response> {
  const person = personWithPassword(form.get("username"), form.get("password"));
  if (!person) return oauthError("invalid_grant", "wrong username or password");
  const token = await signToken({ subject: person.username, ...person });
  return json({ access_token: token, id_token: token, token_type: "Bearer", expires_in: 3600 });
}

async function codeGrant(form: URLSearchParams, clientId: string): Promise<Response> {
  const codeText = form.get("code") ?? "";
  const code = codes.get(codeText);
  // A code works once, so it is gone whether or not this exchange succeeds.
  codes.delete(codeText);
  const usable =
    code &&
    code.expiresAt >= Date.now() &&
    code.clientId === clientId &&
    code.redirectUri === form.get("redirect_uri");
  if (!usable) return oauthError("invalid_grant", "the code is unknown, used or expired");
  const person = people.find((candidate) => candidate.username === code.username) as Person;
  const token = await signToken({ subject: person.username, ...person, nonce: code.nonce });
  return json({ access_token: token, id_token: token, token_type: "Bearer", expires_in: 3600 });
}

async function issueToken(request: Request): Promise<Response> {
  const form = await tokenForm(request);
  const grant = form.get("grant_type");
  if (grant === "password") return passwordGrant(form);
  const credentials = clientCredentials(request, form);
  const client = clients[credentials.id];
  if (!client?.secret || client.secret !== credentials.secret) {
    return oauthError("invalid_client", "client id or secret is wrong", 401);
  }
  if (grant === "client_credentials") {
    const subject = `service:${credentials.id}`;
    const token = await signToken({ subject, name: credentials.id, roles: client.roles });
    return json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
  }
  if (grant === "authorization_code") return codeGrant(form, credentials.id);
  return oauthError("unsupported_grant_type", `grant_type ${grant} is not supported`);
}

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/health") return json({ status: "ok" });
  if (path === "/.well-known/openid-configuration") return discovery();
  if (path === "/jwks") return json({ keys: [signingKey.publicJwk] });
  if (path === "/authorize" && request.method === "GET") return showSignIn(url);
  if (path === "/authorize" && request.method === "POST") return signIn(request);
  if (path === "/token" && request.method === "POST") return issueToken(request);
  return json({ error: "not found" }, 404);
}

Bun.serve({ port: PORT, fetch: answer });
console.log(`sign-in service listening on ${PORT}, issuer ${ISSUER}`);

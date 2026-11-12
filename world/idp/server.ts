// Harrowby's sign-in service: a small OpenID Connect provider with the council's staff and residents.
// It issues signed tokens (RS256) with a "roles" claim. Your service checks them; it never sees a password.
// Grants: authorization_code (staff in a browser), client_credentials (a service identity), password (scripts).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";

const PORT = Number(process.env.PORT ?? 7003);
const ISSUER = process.env.ISSUER ?? `http://localhost:${PORT}`;
const DIR = process.env.IDP_DATA ?? "/data";
const SECRETS = process.env.SECRETS_DIR ?? "/run/secrets";
const DATA = process.env.WORLD_DATA ?? join(import.meta.dir, "..", "data");
mkdirSync(DIR, { recursive: true });

const readSecret = (n: string) => {
  const f = join(SECRETS, n);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
};
const people: { username: string; name: string; roles: string[] }[] = JSON.parse(
  readFileSync(join(DATA, "people.json"), "utf8"),
).people;
const passwords: Record<string, string> = JSON.parse(readSecret("passwords") ?? "{}");
const clients: Record<string, { secret: string; roles: string[] }> = {
  "permit-desk": { secret: readSecret("desk_client_secret") ?? "", roles: ["agent"] },
};

// One signing key, kept across restarts so tokens stay valid.
const keyFile = join(DIR, "signing-key.json");
let priv: CryptoKey, pubJwk: JWK;
if (existsSync(keyFile)) {
  const k = JSON.parse(readFileSync(keyFile, "utf8"));
  priv = (await importJWK(k.private, "RS256")) as CryptoKey;
  pubJwk = k.public;
} else {
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  pubJwk = {
    ...(await exportJWK(kp.publicKey)),
    kid: randomBytes(6).toString("hex"),
    alg: "RS256",
    use: "sig",
  };
  writeFileSync(
    keyFile,
    JSON.stringify({ private: await exportJWK(kp.privateKey), public: pubJwk }),
  );
}

const codes = new Map<
  string,
  { username: string; client_id: string; redirect_uri: string; nonce?: string; exp: number }
>();
const json = (b: unknown, status = 200) =>
  Response.json(b, { status, headers: { "cache-control": "no-store" } });
const oauthErr = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

async function token(sub: string, name: string, roles: string[], aud: string, nonce?: string) {
  return new SignJWT({ name, roles, ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: pubJwk.kid })
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(priv);
}

function page(q: URLSearchParams, error = "") {
  const hidden = [...q]
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, "&quot;")}">`)
    .join("");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Sign in: Harrowby District Council</title>
<style>body{font:16px system-ui;background:#f6f5f1;color:#1d1d1b;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:32px;border-radius:10px;box-shadow:0 2px 12px #0002;width:320px}h1{font-size:20px;margin:0 0 4px}
p{color:#555;margin:0 0 20px;font-size:14px}label{display:block;font-size:14px;margin:12px 0 4px}input{width:100%;padding:8px;box-sizing:border-box;font:inherit}
button{margin-top:20px;width:100%;padding:10px;background:#1f4e3d;color:#fff;border:0;border-radius:6px;font:inherit;cursor:pointer}.e{color:#a33}</style>
<form method="post" action="/authorize"><h1>Harrowby District Council</h1><p>Staff sign-in for the permit desk</p>
${error ? `<p class="e">${error}</p>` : ""}${hidden}<label>Username</label><input name="username" autocomplete="username">
<label>Password</label><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>`,
    { headers: { "content-type": "text/html" } },
  );
}

const redirectOk = (uri: string) =>
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/staff\/callback$/.test(uri);

function clientAuth(req: Request, form: URLSearchParams) {
  const basic = req.headers.get("authorization");
  if (basic?.startsWith("Basic ")) {
    const [id, secret] = atob(basic.slice(6)).split(":");
    return { id: decodeURIComponent(id), secret: decodeURIComponent(secret ?? "") };
  }
  return { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (url.pathname === "/.well-known/openid-configuration")
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
    if (url.pathname === "/jwks") return json({ keys: [pubJwk] });

    if (url.pathname === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      if (!clients[q.get("client_id") ?? ""])
        return oauthErr("unauthorized_client", "unknown client_id");
      if (!redirectOk(q.get("redirect_uri") ?? ""))
        return oauthErr(
          "invalid_request",
          "redirect_uri must be http://localhost:<port>/staff/callback",
        );
      return page(q);
    }
    if (url.pathname === "/authorize" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const u = people.find((p) => p.username === f.get("username"));
      const back = new URLSearchParams(
        [...f].filter(([k]) => !["username", "password"].includes(k)),
      );
      if (!u || !passwords[u.username] || passwords[u.username] !== f.get("password"))
        return page(back, "That username and password do not match.");
      if (!redirectOk(f.get("redirect_uri") ?? ""))
        return oauthErr("invalid_request", "bad redirect_uri");
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        username: u.username,
        client_id: f.get("client_id")!,
        redirect_uri: f.get("redirect_uri")!,
        nonce: f.get("nonce") ?? undefined,
        exp: Date.now() + 60_000,
      });
      const to = new URL(f.get("redirect_uri")!);
      to.searchParams.set("code", code);
      if (f.get("state")) to.searchParams.set("state", f.get("state")!);
      return Response.redirect(to.toString(), 302);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      const f = ct.includes("json")
        ? new URLSearchParams((await req.json()) as Record<string, string>)
        : new URLSearchParams(await req.text());
      const grant = f.get("grant_type");
      const aud = "permit-desk";
      if (grant === "password") {
        const u = people.find((p) => p.username === f.get("username"));
        if (!u || !passwords[u.username] || passwords[u.username] !== f.get("password"))
          return oauthErr("invalid_grant", "wrong username or password");
        const t = await token(u.username, u.name, u.roles, aud);
        return json({ access_token: t, id_token: t, token_type: "Bearer", expires_in: 3600 });
      }
      const c = clientAuth(req, f);
      const client = clients[c.id];
      if (!client || !client.secret || client.secret !== c.secret)
        return oauthErr("invalid_client", "client id or secret is wrong", 401);
      if (grant === "client_credentials") {
        const t = await token(`service:${c.id}`, c.id, client.roles, aud);
        return json({ access_token: t, token_type: "Bearer", expires_in: 3600 });
      }
      if (grant === "authorization_code") {
        const code = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        if (
          !code ||
          code.exp < Date.now() ||
          code.client_id !== c.id ||
          code.redirect_uri !== f.get("redirect_uri")
        )
          return oauthErr("invalid_grant", "the code is unknown, used or expired");
        const u = people.find((p) => p.username === code.username)!;
        const t = await token(u.username, u.name, u.roles, aud, code.nonce);
        return json({ access_token: t, id_token: t, token_type: "Bearer", expires_in: 3600 });
      }
      return oauthErr("unsupported_grant_type", `grant_type ${grant} is not supported`);
    }
    return json({ error: "not found" }, 404);
  },
});
console.log(`sign-in service listening on ${PORT}, issuer ${ISSUER}`);

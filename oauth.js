// oauth.js — OAuth 2.1 with Dynamic Client Registration.
//
// Claude and ChatGPT both require an OAuth handshake; a bare token is not
// accepted. This is the smallest implementation that satisfies them.
//
// Sign-in asks for an organisation name and AJEMS secret key, verifies them
// against the live API, then issues an opaque access token that maps to that
// tenant. The AI never receives the secret key.

import crypto from "node:crypto";
import fs from "node:fs";
import { originOf } from "./util.js";

const SESSION_FILE = process.env.SESSION_FILE || "./sessions.json";
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_S = 60 * 60 * 24 * 90;
const MAX_CLIENTS = 5000;

const rnd = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

const clients = new Map();   // client_id -> { redirect_uris, name }
const codes = new Map();     // code      -> { ctx, redirect_uri, pkce, scope, expires }
let sessions = {};           // token     -> { tenant, baseUrl, secretKey, user, created }

// --- session persistence ----------------------------------------------------
// Without this, every restart or deploy signs every user out.

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    console.log(`Loaded ${Object.keys(sessions).length} saved session(s)`);
  } catch (e) {
    console.warn("Could not read sessions file:", e.message);
  }
}

function saveSessions() {
  try {
    // Write then rename: a crash mid-write can't corrupt the real file, and two
    // simultaneous sign-ins can't interleave.
    const tmp = `${SESSION_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SESSION_FILE);
  } catch (e) {
    console.warn("Could not write sessions file:", e.message);
  }
}

loadSessions();

export const lookupSession = (token) => sessions[token] || null;
export const sessionCount = () => Object.keys(sessions).length;

/** Every saved session. Used at startup to re-link organisations. */
export const allSessions = () => Object.values(sessions);

/**
 * Remove one session and return { tenant, remaining } so the caller can decide
 * whether the organisation still has another active session.
 */
export function revokeSession(token) {
  const session = sessions[token];
  if (!session) return null;
  delete sessions[token];
  saveSessions();
  return { tenant: session.tenant, remaining: Object.values(sessions) };
}

// Expired codes and stale registrations would otherwise accumulate.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of codes) if (entry.expires < now) codes.delete(code);
  if (clients.size > MAX_CLIENTS) {
    const keep = [...clients.entries()].slice(-2000);
    clients.clear();
    for (const [id, client] of keep) clients.set(id, client);
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The sign-in page. `params` are echoed back through hidden inputs. */
function signInPage({ error, org = "", ...params }) {
  const hidden = ["redirect_uri", "state", "client_id", "code_challenge", "code_challenge_method", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params[name])}">`)
    .join("\n  ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connect AJEMS</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 *{box-sizing:border-box}
 body{font-family:system-ui,-apple-system,sans-serif;background:#f4f5f7;display:flex;
      align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
 .card{background:#fff;padding:34px;border-radius:14px;max-width:440px;width:100%;
       box-shadow:0 2px 12px rgba(0,0,0,.08)}
 h1{font-size:21px;margin:0 0 6px;font-weight:650;color:#111}
 .sub{color:#666;font-size:14px;line-height:1.5;margin:0 0 22px}
 label{font-size:13px;font-weight:600;display:block;margin:16px 0 6px;color:#333}
 input[type=text],input[type=password]{width:100%;padding:11px 12px;border:1px solid #d4d6da;
      border-radius:7px;font-size:14px;font-family:ui-monospace,monospace}
 input:focus{outline:2px solid #2563eb;outline-offset:-1px;border-color:#2563eb}
 .hint{font-size:12px;color:#888;margin-top:5px}
 button{width:100%;margin-top:22px;padding:12px;background:#2563eb;color:#fff;border:0;
        border-radius:7px;font-size:15px;font-weight:600;cursor:pointer}
 button:hover{background:#1d4ed8}
 .err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:11px 13px;
      border-radius:7px;font-size:13px;margin-bottom:18px;line-height:1.45}
 .foot{margin-top:20px;font-size:12px;color:#999;line-height:1.5;text-align:center}
</style></head><body><div class="card">
 <h1>Connect to AJEMS</h1>
 <p class="sub">Sign in with your workspace details to give this AI assistant access to your AJEMS data.</p>
 ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
 <form method="POST" action="/authorize/approve">
  ${hidden}
  <label for="org">Organisation name</label>
  <input id="org" type="text" name="organisation" autocomplete="off" spellcheck="false"
         required value="${escapeHtml(org)}" placeholder="yourorg" autofocus>
  <div class="hint">The subdomain of your AJEMS workspace</div>

  <label for="key">Secret key</label>
  <input id="key" type="password" name="secret_key" autocomplete="off" spellcheck="false"
         required placeholder="Your X-Json-Builder-Secret-Key">
  <div class="hint">Found in AJEMS under API settings</div>

  <button type="submit">Connect</button>
 </form>
 <p class="foot">Your secret key is stored on this server only. The AI assistant never receives it.</p>
</div></body></html>`;
}

export function mountOAuth(app, { publicUrl, verifyCredentials }) {
  const origin = (req) => originOf(req, publicUrl);

  app.use((req, _res, next) => {
    if (/^\/(\.well-known|register|authorize|token)/.test(req.path)) {
      console.log(`[oauth] ${req.method} ${req.path}`);
    }
    next();
  });

  // --- Discovery -----------------------------------------------------------

  const authServerMetadata = (req, res) => {
    const base = origin(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["ajems:read", "ajems:write"],
    });
  };

  const resourceMetadata = (req, res) => {
    const base = origin(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ["ajems:read", "ajems:write"],
    });
  };

  // Clients differ on whether they append the resource path, so serve both.
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    app.get(path, authServerMetadata);
    app.get(`${path}/*splat`, authServerMetadata);
  }
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get("/.well-known/oauth-protected-resource/*splat", resourceMetadata);

  // --- Dynamic client registration -----------------------------------------

  app.post("/register", (req, res) => {
    const client_id = `ajems-client-${rnd(8)}`;
    const redirect_uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    const client_name = req.body?.client_name || "MCP client";

    clients.set(client_id, { redirect_uris, name: client_name });

    res.status(201).json({
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris,
      client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  });

  /**
   * Only redirect somewhere the client registered. Without this the sign-in
   * page is an open redirect and codes could be delivered to an attacker.
   * Unregistered clients (our own test scripts) are allowed through.
   */
  function redirectAllowed(clientId, redirectUri) {
    const client = clients.get(clientId);
    if (!client || !client.redirect_uris.length) return true;
    return client.redirect_uris.includes(redirectUri);
  }

  // --- Authorize ------------------------------------------------------------

  app.get("/authorize", (req, res) => {
    const { redirect_uri, client_id } = req.query;
    if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
    if (!redirectAllowed(client_id, redirect_uri)) {
      return res.status(400).send("redirect_uri does not match this client's registration");
    }
    res.type("html").send(signInPage(req.query));
  });

  app.post("/authorize/approve", async (req, res) => {
    const { redirect_uri, client_id, organisation, secret_key } = req.body || {};

    if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
    if (!redirectAllowed(client_id, redirect_uri)) {
      return res.status(400).send("redirect_uri does not match this client's registration");
    }

    const retry = (error) =>
      res.status(401).type("html").send(signInPage({ ...req.body, error, org: organisation }));

    if (!organisation?.trim() || !secret_key?.trim()) {
      return retry("Enter both your organisation name and secret key.");
    }

    let ctx;
    try {
      ctx = await verifyCredentials(organisation.trim(), secret_key.trim());
    } catch (e) {
      return retry(e.message);
    }
    if (!ctx) return retry("Could not verify those details.");

    const code = rnd(24);
    codes.set(code, {
      ctx,
      redirect_uri,
      code_challenge: req.body.code_challenge || null,
      code_challenge_method: req.body.code_challenge_method || null,
      scope: req.body.scope || "ajems:read ajems:write",
      expires: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (req.body.state) url.searchParams.set("state", req.body.state);
    res.redirect(url.toString());
  });

  // --- Token ---------------------------------------------------------------

  app.post("/token", (req, res) => {
    const { grant_type, code, code_verifier } = req.body || {};

    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }

    const entry = codes.get(code);
    codes.delete(code);   // single use, whatever happens next
    if (!entry || entry.expires < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    // PKCE: prove the caller is the app that started the flow, so a stolen
    // authorization code is useless on its own.
    if (entry.code_challenge) {
      if (!code_verifier) {
        return res.status(400).json({ error: "invalid_request", error_description: "code_verifier required" });
      }
      const derived = entry.code_challenge_method === "S256"
        ? crypto.createHash("sha256").update(code_verifier).digest("base64url")
        : code_verifier;
      if (derived !== entry.code_challenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }
    }

    const access_token = `ajems_oauth_${rnd(24)}`;
    sessions[access_token] = { ...entry.ctx, created: new Date().toISOString() };
    saveSessions();
    console.log(`[oauth] issued token for "${entry.ctx.tenant}"`);

    res.json({
      access_token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_S,
      scope: entry.scope,
    });
  });
}

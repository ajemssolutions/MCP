// oauth.js — the OAuth 2.1 handshake Claude and ChatGPT require, with "Sign in with AJEMS".
//
// The person types only their workspace name here. The password is typed on AJEMS's own
// /connect page (their normal login), never on this server:
//
//   Claude ─► /authorize (workspace name) ─► https://<org>.<web>/connect  "Allow Claude?"
//          ◄─ /oauth/callback?code=… ◄─ AJEMS        (swap: POST /ajen/mcp/token/, secret + PKCE)
//          ─► /token  ─► access token = the person's 7-day AJEMS token, sealed with SESSION_KEY
//
// Nothing is stored: client ids, the sign-in steps and codes are sealed values. No refresh
// token: when the 7 days end, Claude / ChatGPT asks the person to sign in again.

import { config } from "./config.js";
import { orgName, swapCode, webBase, Refused, SignedOut } from "./ajems.js";
import { challengeOf, randomToken, safeEqual, seal, sha256, unseal } from "./seal.js";
import { store } from "./store.js";

const STEP_SECONDS = 15 * 60;      // from /authorize to coming back from AJEMS
const CODE_SECONDS = 120;          // our code to Claude / ChatGPT
const CALLBACK = () => `${config.publicUrl}/oauth/callback`;
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------------------
// where a code may be sent
// ---------------------------------------------------------------------------------------

export function redirectPermitted(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) return config.allowLocalRedirects;
    if (u.protocol !== "https:" || u.username || u.password || u.hash) return false;
    if (u.href !== uri) return false;                 // dot segments, %2e%2e … never pass
    return config.allowedRedirects.some((allowed) => allowed.endsWith("*")
      ? u.href.startsWith(allowed.slice(0, -1)) && u.href.length > allowed.length - 1
      : u.href === allowed);
  } catch {
    return false;
  }
}

/** Which AI is asking, from where it wants the code (its platform fixes that address). */
export function clientOf(redirectUri) {
  try {
    const host = new URL(redirectUri).hostname;
    if (/(^|\.)claude\.(ai|com)$/.test(host)) return "claude";
    if (/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/.test(host)) return "chatgpt";
  } catch {}
  return "other";
}

// ---------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

const redirect = (res, url) => { res.writeHead(302, { Location: url, "Cache-Control": "no-store" }); res.end(); };

const withQuery = (base, params) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  return u.toString();
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Where the workspace form may send the person: this connector, then their AJEMS website
// (https://*.ajems-staging.com on staging, https://*.ajems.in on live). Chrome applies
// form-action to the redirect after the form too, so the AJEMS website must be listed.
function ajemsWebSource() {
  try {
    const u = new URL(config.webTemplate.replace("{org}", "x"));
    return u.hostname.startsWith("x.") ? `${u.protocol}//*.${u.host.slice(2)}` : `${u.protocol}//${u.host}`;
  } catch {
    return "https:";
  }
}

const pageHeaders = () => ({
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY",
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${ajemsWebSource()}; frame-ancestors 'none'; base-uri 'none'`,
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
});

function page(res, status, { title, body }) {
  const label = config.envLabel ? `<span class="tag">${esc(config.envLabel)}</span>` : "";
  res.writeHead(status, pageHeaders());
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AJEMS</title><style>
:root{--blue:#2566DD;--ink:#1A2233;--muted:#5B6B85;--line:#E3E9F6;--bg:#F2F6FE;--danger:#B42020;--danger-bg:#FDEDED}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
.card{width:100%;max-width:420px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 12px 32px rgba(16,32,64,.08)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-.01em;color:var(--blue);margin-bottom:18px}
.dot{width:26px;height:26px;border-radius:8px;background:var(--blue);color:#fff;display:grid;place-items:center;font-size:13px}
.tag{margin-left:auto;font-size:11px;font-weight:600;color:#9A5A06;background:#FDF1E1;border-radius:20px;padding:2px 8px}
h1{font-size:21px;margin:0 0 6px;letter-spacing:-.02em}p{margin:0 0 14px;color:var(--muted)}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}
.field{display:flex;align-items:center;border:1px solid #D2DBEC;border-radius:10px;overflow:hidden}
.field:focus-within{border-color:var(--blue);box-shadow:0 0 0 3px #EAF0F9}
input{flex:1;min-width:0;border:0;padding:11px 12px;font:inherit;outline:0}.suffix{padding:0 12px;color:var(--muted);font-size:13px;white-space:nowrap}
button{width:100%;margin-top:18px;border:0;border-radius:10px;background:var(--blue);color:#fff;font:inherit;font-weight:600;padding:12px;cursor:pointer}
button:hover{background:#1F57BC}.err{background:var(--danger-bg);color:var(--danger);border-radius:10px;padding:10px 12px;font-size:13px;margin:0 0 12px}
.small{font-size:12px;margin-top:16px}
</style></head><body><main class="card"><div class="brand"><span class="dot">A</span>AJEMS${label}</div>${body}</main></body></html>`);
}

const errorPage = (res, status, message) => page(res, status, {
  title: "Could not connect", body: `<h1>Could not connect</h1><p class="err">${esc(message)}</p>
<p class="small">Close this window and add the AJEMS connector again from Claude or ChatGPT.</p>` });

function parseText(text, contentType) {
  const t = String(text || "").trim();
  if (contentType.includes("application/json") || t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t || "{}"); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(t));
}

async function readBody(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  // Vercel may hand the body over already read: an object, a string or a Buffer.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return parseText(req.body.toString("utf8"), contentType);
    if (typeof req.body === "string") return parseText(req.body, contentType);
    if (typeof req.body === "object") return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk);
  }
  return parseText(Buffer.concat(chunks).toString("utf8"), contentType);
}
export { readBody };

const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

// ---------------------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------------------

export function protectedResource(res) {
  json(res, 200, { resource: `${config.publicUrl}/mcp`, authorization_servers: [config.publicUrl],
                   bearer_methods_supported: ["header"], resource_name: "AJEMS" });
}

export function authorizationServer(res) {
  json(res, 200, {
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/authorize`,
    token_endpoint: `${config.publicUrl}/token`,
    registration_endpoint: `${config.publicUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["ajems"],
  });
}

// ---------------------------------------------------------------------------------------
// client registration (sealed client id: nothing stored)
// ---------------------------------------------------------------------------------------

export async function register(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  const refused = uris.filter((u) => !redirectPermitted(u));
  if (!uris.length || uris.length > 5 || refused.length) {
    const why = !uris.length ? "no redirect_uris were sent" : refused.length ? `not allowed: ${refused.join(", ")}` : "too many redirect_uris";
    console.warn(`[register] refused (${why}) client=${String(body.client_name || "").slice(0, 60)} keys=${Object.keys(body || {}).join(",")}`);
    return json(res, 400, { error: "invalid_redirect_uri",
      error_description: `Only Claude's and ChatGPT's own callback addresses may register (${why}).` });
  }
  const name = String(body.client_name || clientOf(uris[0])).slice(0, 80);
  const clientId = seal("client", { n: name, r: uris });
  // A client that asks for a secret gets one (PKCE and the sealed code protect the sign-in either way).
  const method = ["client_secret_post", "client_secret_basic"].includes(body.token_endpoint_auth_method)
    ? body.token_endpoint_auth_method : "none";
  console.log(`[register] ok client=${name} redirect=${uris.join(",")} auth=${method}`);
  json(res, 201, { client_id: clientId, client_name: name, redirect_uris: uris, client_id_issued_at: now(),
                   token_endpoint_auth_method: method, grant_types: ["authorization_code"], response_types: ["code"],
                   ...(method !== "none" ? { client_secret: randomToken(32), client_secret_expires_at: 0 } : {}) });
}

const clientFrom = (clientId) => unseal("client", clientId);

// ---------------------------------------------------------------------------------------
// /authorize: the workspace name, then off to AJEMS's own /connect page
// ---------------------------------------------------------------------------------------

function checkRequest(q) {
  const client = clientFrom(q.client_id);
  if (!client) return { error: "This connection request is not from a registered client." };
  if (q.response_type !== "code") return { error: "Unsupported response_type." };
  if (!client.r.includes(q.redirect_uri) || !redirectPermitted(q.redirect_uri)) return { error: "This return address is not allowed." };
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || "")) {
    return { error: "This connection request needs PKCE (S256)." };
  }
  return { client };
}

function orgForm(res, { req, error = "", org = "" }) {
  const suffix = esc(config.webTemplate.replace(/^https?:\/\/\{org\}/, "").replace(/\/.*$/, ""));
  page(res, error ? 400 : 200, { title: "Connect AJEMS", body: `<h1>Connect AJEMS</h1>
<p>Enter your workspace. You will sign in on your own AJEMS page — your password is never typed here.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="req" value="${esc(req)}">
<label for="org">Workspace</label>
<div class="field"><input id="org" name="org" value="${esc(org)}" placeholder="yourcompany" autocomplete="organization" autocapitalize="none" spellcheck="false" required autofocus><span class="suffix">${suffix}</span></div>
<button type="submit">Continue to AJEMS</button></form>
<p class="small">Claude or ChatGPT will then work in AJEMS as you, with exactly your permissions.</p>` });
}

export function authorizeGet(req, res, query) {
  const { error } = checkRequest(query);
  if (error) return errorPage(res, 400, error);
  const sealed = seal("req", { cid: sha256(query.client_id), r: query.redirect_uri, s: String(query.state || "").slice(0, 500),
                                c: query.code_challenge, e: now() + STEP_SECONDS });
  orgForm(res, { req: sealed });
}

export async function authorizePost(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const pending = unseal("req", body.req);
  if (!pending || pending.e < now()) return errorPage(res, 400, "This sign-in took too long. Start again from Claude or ChatGPT.");
  if (await store.incr(`signin:${ipOf(req)}`, 3600) > config.signInPerIpPerHour) {
    return errorPage(res, 429, "Too many sign-in attempts from here. Wait a while and try again.");
  }
  const org = orgName(body.org);
  if (!org) return orgForm(res, { req: body.req, org: body.org, error: "Enter your workspace name: letters, digits and dashes only." });
  const verifier = randomToken(48);
  const state = seal("step", { ...pending, org, v: verifier });
  redirect(res, withQuery(`${webBase(org)}/connect`, {
    client: clientOf(pending.r), redirect_uri: CALLBACK(), state,
    code_challenge: challengeOf(verifier), code_challenge_method: "S256",
  }));
}

// ---------------------------------------------------------------------------------------
// back from AJEMS: swap its code, hand Claude / ChatGPT our own code
// ---------------------------------------------------------------------------------------

export async function callback(req, res, query) {
  const step = unseal("step", query.state);
  if (!step || step.e < now()) return errorPage(res, 400, "This sign-in took too long or did not start here. Start again from Claude or ChatGPT.");
  if (query.error) return redirect(res, withQuery(step.r, { error: "access_denied", state: step.s }));
  if (!query.code) return errorPage(res, 400, "AJEMS did not send a sign-in code.");
  let granted;
  try {
    granted = await swapCode(step.org, { code: query.code, verifier: step.v, redirectUri: CALLBACK() });
  } catch (e) {
    const why = e instanceof SignedOut ? "AJEMS did not accept this sign-in. Start again from Claude or ChatGPT." : e.message;
    console.warn(`[signin] org=${step.org} swap failed: ${e.message}`);
    return errorPage(res, e instanceof Refused && e.status === 403 ? 403 : 400, why);
  }
  if (!granted?.access_token) return errorPage(res, 502, "AJEMS did not send a token.");
  const code = seal("code", { org: step.org, t: granted.access_token, x: Number(granted.expires_at) || now() + 7 * 86400,
                              r: step.r, c: step.c, cid: step.cid, k: clientOf(step.r), e: now() + CODE_SECONDS });
  console.log(`[signin] org=${step.org} user=${granted.user?.id ?? "?"} client=${clientOf(step.r)} connected`);
  redirect(res, withQuery(step.r, { code, state: step.s }));
}

// ---------------------------------------------------------------------------------------
// /token: our code → the access token Claude / ChatGPT holds (7 days, then sign in again)
// ---------------------------------------------------------------------------------------

export async function token(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const fail = (error, description, status = 400) => json(res, status, { error, error_description: description });
  if (body.grant_type !== "authorization_code") {
    return fail("unsupported_grant_type", "Only authorization_code. When the 7-day sign-in ends, sign in again.");
  }
  const code = unseal("code", body.code);
  if (!code || code.e < now()) return fail("invalid_grant", "The code is unknown or expired.");
  if (body.redirect_uri !== code.r) return fail("invalid_grant", "redirect_uri does not match.");
  if (body.client_id && !safeEqual(sha256(body.client_id), code.cid)) return fail("invalid_grant", "client_id does not match.");
  if (!body.code_verifier || !safeEqual(challengeOf(String(body.code_verifier)), code.c)) return fail("invalid_grant", "PKCE check failed.");
  if (!(await store.claim(`code:${sha256(body.code)}`, CODE_SECONDS + 60))) return fail("invalid_grant", "The code was already used.");
  const left = code.x - now();
  if (left <= 60) return fail("invalid_grant", "The AJEMS sign-in has already ended. Sign in again.");
  const access = seal("access", { org: code.org, t: code.t, x: code.x, k: code.k });
  json(res, 200, { access_token: access, token_type: "Bearer", expires_in: left, scope: "ajems" });
}

/** The signed-in person behind an access token, or null (not ours, changed, or past its 7 days). */
export function contextOf(authorization) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorization || ""));
  const ctx = m ? unseal("access", m[1].trim()) : null;
  if (!ctx || !ctx.org || !ctx.t || ctx.x <= now()) return null;
  return { org: ctx.org, token: ctx.t, expires: ctx.x, client: ctx.k || "other" };
}

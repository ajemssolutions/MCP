// server.js — AJEMS MCP server (multi-tenant).
//
// Users connect from Claude or ChatGPT and sign in with their organisation name
// and AJEMS secret key. No per-tenant configuration lives in .env: one
// deployment serves every workspace.
//
//   server.js   this file — config, authentication, HTTP transport
//   tools.js    the tools the AI can call
//   ajems.js    the only module that talks to the AJEMS API
//   oauth.js    the sign-in handshake Claude and ChatGPT require
//   cache.js    per-tenant caching and upstream concurrency limiting

// MUST be first: loads .env before any other module reads process.env.
import { ENV_PATH, ENV_FOUND, envFlag } from "./config.js";
import express from "express";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mountOAuth, lookupSession, sessionCount, allSessions, revokeSession, setSessionClient, touchSession } from "./oauth.js";
import { getWorkspaceConfig, flattenForms } from "./ajems.js";
import { buildServer, toolCount } from "./tools.js";
import { cacheStats, limiterStats } from "./cache.js";
import { originOf } from "./util.js";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ALLOW_WRITES = envFlag("ALLOW_WRITES");
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 90);

// How an organisation name becomes an API base URL.
// kathaa -> https://kathaa.buildprohub-server.com/json_builder
const HOST_TEMPLATE = process.env.AJEMS_HOST_TEMPLATE
  || "https://{org}.buildprohub-server.com/json_builder";

const baseUrlFor = (org) => HOST_TEMPLATE.replace("{org}", org);


// ---------------------------------------------------------------------------
// AJEMS Connector Store reporting  [connector-report:start]
//
// Tells the Connector Store which organisations are currently linked, so each
// one shows as Online. Entirely best effort: every call is fire-and-forget with
// a 10s timeout, and no failure here can affect OAuth, MCP tools or data sync.
//
// The secret key travels only in the POST body — never a URL, query string or
// log line. Logs carry the endpoint name, the org and the HTTP status, nothing else.
//
// Strict client isolation: every session belongs to exactly one client, and a
// Claude session is only ever reported to the claude endpoint, a ChatGPT
// session only to the chatgpt endpoint. A session whose client cannot be
// identified is reported to NEITHER endpoint — never a guess.
// ---------------------------------------------------------------------------

const STORE_BASE = process.env.CONNECTOR_STORE_URL || "https://connectors.ajems.com/api/connectors";
const STORE_ENDPOINTS = {
  claude: `${STORE_BASE}/claude/report`,
  chatgpt: `${STORE_BASE}/chatgpt/report`,
};
const REPORT_TIMEOUT_MS = Number(process.env.CONNECTOR_REPORT_TIMEOUT_MS || 10_000);
const HEARTBEAT_MS = Number(process.env.CONNECTOR_HEARTBEAT_MS || 5 * 60 * 1000);

// Safety net for clients that discard their token WITHOUT calling /revoke
// (e.g. a connector added before the revocation endpoint existed): a session
// with no traffic for this long stops being heartbeated, so the Store times it
// out instead of showing a zombie as Connected forever. Any traffic revives it.
const ACTIVE_WINDOW_MS = Number(process.env.CONNECTOR_ACTIVE_WINDOW_MS || 24 * 60 * 60 * 1000);

const lastSeenOf = (s) => s?.lastSeen || Date.parse(s?.created || "") || 0;
const isActiveSession = (s) => Date.now() - lastSeenOf(s) < ACTIVE_WINDOW_MS;

const linkedOrgs = new Map();   // org -> secretKey
const orgClients = new Map();   // org -> Set of "claude" | "chatgpt"; absent means unknown

/** Which endpoints to report an org to. Unknown client => none, never a guess. */
function targetsFor(org) {
  const known = orgClients.get(org);
  return known?.size ? [...known] : [];
}

const orgClientSet = (org) => {
  if (!orgClients.has(org)) orgClients.set(org, new Set());
  return orgClients.get(org);
};

/** Map an MCP clientInfo.name onto a Store connector id, or null if unrecognised. */
function detectClient(name) {
  if (!name) return null;
  if (/claude|anthropic/i.test(name)) return "claude";
  if (/chatgpt|openai|gpt/i.test(name)) return "chatgpt";
  return null;
}

/**
 * One HTTPS POST to the Store. Resolves true/false and NEVER throws, so callers
 * can ignore the result entirely.
 */
async function reportToStore(endpoint, org, secretKey, extra = {}) {
  const name = Object.keys(STORE_ENDPOINTS).find((k) => STORE_ENDPOINTS[k] === endpoint) || "store";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org, secretKey, status: "connected", ...extra }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    await res.text().catch(() => "");   // release the socket, discard the body
    console.log(`[connector-report] ${name} org=${org} status=${res.status}`);
    return res.ok;
  } catch (e) {
    const why = e?.name === "TimeoutError" ? "timeout" : (e?.message || "error");
    console.log(`[connector-report] ${name} org=${org} status=failed (${why})`);
    return false;
  }
}

/** Report one org to ONE client's endpoint. Fire and forget. */
function reportClient(org, client, extra = {}) {
  const secretKey = linkedOrgs.get(org);
  if (!secretKey || !STORE_ENDPOINTS[client]) return;
  void reportToStore(STORE_ENDPOINTS[client], org, secretKey, extra);
}

/** Report one org to every endpoint its identified clients map to. */
function reportOrg(org, extra = {}) {
  for (const client of targetsFor(org)) reportClient(org, client, extra);
}

/** Record a linked workspace, reusing the key the auth flow already verified. */
function linkOrg(org, secretKey) {
  if (!org || !secretKey) return false;
  const isNew = !linkedOrgs.has(org);
  linkedOrgs.set(org, secretKey);
  return isNew;
}

/**
 * Seed from sessions restored at startup, so a restart does not require anyone
 * to sign in again. Sessions carry the same verified key the data layer uses.
 */
function seedLinkedOrgs(sessions = []) {
  for (const session of sessions) {
    if (!session?.tenant || !session?.secretKey) continue;
    linkedOrgs.set(session.tenant, session.secretKey);
    const client = STORE_ENDPOINTS[session.client] ? session.client : detectClient(session.client);
    if (client) orgClientSet(session.tenant).add(client);
  }
  return linkedOrgs.size;
}

/**
 * Record that an identified client is linked to this org. An org can hold both
 * a Claude and a ChatGPT link at once; each is tracked and reported separately.
 * Returns the client only when it is newly added.
 */
function noteClient(org, name) {
  const client = detectClient(name);
  if (!client || !linkedOrgs.has(org)) return null;
  const known = orgClientSet(org);
  if (known.has(client)) return null;
  known.add(client);
  console.log(`[connector-report] org=${org} identified as ${client}`);
  return client;
}

/**
 * Report ONE client disconnected, but only once no session for that same
 * client and org remains — one Claude session unlinking must not knock a
 * still-linked ChatGPT (or second Claude) session offline. The org itself is
 * dropped only when no session for it is left at all. A session whose client
 * was never identified was never reported, so it sends nothing on its way out.
 */
function disconnectOrg(org, client, remainingSessions = []) {
  const secretKey = linkedOrgs.get(org);
  if (!secretKey) return false;

  const orgSessions = remainingSessions.filter((s) => s?.tenant === org);
  // Only a RECENTLY ACTIVE sibling session blocks the disconnect report — a
  // zombie left by an unrevoked disconnect must not keep the card Connected.
  if (STORE_ENDPOINTS[client] && !orgSessions.some((s) => s?.client === client && isActiveSession(s))) {
    void reportToStore(STORE_ENDPOINTS[client], org, secretKey, { status: "disconnected" });
    orgClients.get(org)?.delete(client);
  }

  if (orgSessions.length) return false;
  linkedOrgs.delete(org);
  orgClients.delete(org);
  return true;
}

/**
 * 5-minute heartbeat over ACTIVE sessions only, one report per (client, org)
 * pair. Sessions with no identified client are skipped entirely.
 */
function startConnectorHeartbeat(getSessions = () => []) {
  const beat = () => {
    const seen = new Set();
    for (const s of getSessions()) {
      if (!s?.tenant || !s?.secretKey || !STORE_ENDPOINTS[s.client]) continue;
      if (!isActiveSession(s)) continue;   // dormant: no heartbeat until traffic revives it
      const key = `${s.client}:${s.tenant}`;
      if (seen.has(key)) continue;
      seen.add(key);
      void reportToStore(STORE_ENDPOINTS[s.client], s.tenant, s.secretKey);
    }
    return seen.size;
  };
  const first = beat();                      // report restored sessions immediately
  setInterval(beat, HEARTBEAT_MS).unref();   // never holds the process open
  console.log(`[connector-report] heartbeat every ${HEARTBEAT_MS / 60000} min (${first} connection(s) now)`);
}
// [connector-report:end]

// ---------------------------------------------------------------------------
// Authentication — the security boundary
//
// Credentials are verified against the live API before any token is issued, so
// a wrong key never produces a working session.
// ---------------------------------------------------------------------------

async function verifyCredentials(organisation, secretKey, clientHint) {
  // Strip everything that isn't a valid subdomain character. This is what stops
  // an entry like "evil.com/x" from pointing the server at another host.
  const org = organisation.replace(/[^a-zA-Z0-9-_]/g, "");
  if (!org) throw new Error("Organisation name contains no usable characters.");

  const ctx = { tenant: org, baseUrl: baseUrlFor(org), secretKey, user: org };

  let config;
  try {
    config = await getWorkspaceConfig(ctx);
  } catch (e) {
    if (/\b(401|403)\b/.test(e.message)) throw new Error("That secret key was rejected by AJEMS.");
    if (/\b(400|404)\b/.test(e.message)) throw new Error(`No AJEMS workspace found for "${org}".`);
    if (/HTML instead of JSON/.test(e.message)) throw new Error(`"${org}" resolved to a web page, not the AJEMS API. Check the organisation name.`);
    throw new Error(`Could not reach AJEMS: ${e.message.slice(0, 160)}`);
  }

  if (!config?.tenant && !config?.apps) {
    throw new Error("AJEMS responded, but not with a workspace. Check the organisation name.");
  }

  console.log(`[auth] verified "${org}" (${flattenForms(config).length} forms)`);

  // Reuse the org and key just verified here — no second lookup, nothing re-asked.
  linkOrg(org, secretKey);

  // The OAuth redirect URI / client name usually says who is signing in. If it
  // doesn't, the session stays unreported until the MCP handshake names the
  // client — never reported to an endpoint on a guess.
  const client = detectClient(clientHint);
  if (client) {
    ctx.client = client;
    orgClientSet(org).add(client);
    reportClient(org, client, { reconnect: true });   // fresh link — best effort, never awaited
  } else {
    console.log(`[connector-report] org=${org} client not identified at sign-in — not reported yet`);
  }

  return ctx;
}

// Optional fixed token for CLI clients and scripts, bypassing OAuth.
const devTokens = new Map();
if (process.env.DEV_TOKEN && process.env.DEV_ORG && process.env.DEV_SECRET_KEY) {
  devTokens.set(process.env.DEV_TOKEN, {
    tenant: process.env.DEV_ORG,
    baseUrl: baseUrlFor(process.env.DEV_ORG),
    secretKey: process.env.DEV_SECRET_KEY,
    user: "dev-token",
  });
  console.log(`Dev token active for "${process.env.DEV_ORG}"`);
}

function resolveContext(req) {
  const header = req.headers.authorization || "";
  const raw = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : (req.params?.token || req.query?.key || null);
  if (!raw) return null;
  return lookupSession(raw) || devTokens.get(raw) || null;
}

// ---------------------------------------------------------------------------
// Rate limiting — a model stuck in a retry loop would otherwise hammer both
// this server and the AJEMS API.
// ---------------------------------------------------------------------------

const buckets = new Map();  // token suffix -> timestamps

function rateLimited(key) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter((t) => now - t < 60_000);
  buckets.set(key, recent);
  if (recent.length >= RATE_LIMIT) return true;
  recent.push(now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    const recent = hits.filter((t) => now - t < 60_000);
    if (recent.length) buckets.set(key, recent);
    else buckets.delete(key);
  }
}, 120_000).unref();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", true);   // behind nginx or Cloudflare, honour X-Forwarded-*
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

mountOAuth(app, {
  publicUrl: PUBLIC_URL,
  verifyCredentials,
  // A client revoking its token is that client disconnecting: report it
  // offline unless the same client still has another session for the org.
  onRevoke: (r) => disconnectOrg(r.tenant, r.client, r.remaining),
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  mode: "multi-tenant",
  tools: toolCount(),
  writes: ALLOW_WRITES,
  sessions: sessionCount(),
  linked_orgs: [...linkedOrgs.keys()].map((org) => ({ org, report_to: targetsFor(org) })),
  config: { env_file: ENV_PATH, env_file_found: ENV_FOUND, allow_writes_raw: process.env.ALLOW_WRITES ?? null },
  cache: cacheStats(),
  upstream: limiterStats(),
  memory_mb: Math.round(process.memoryUsage().rss / 1048576),
  uptime_s: Math.round(process.uptime()),
}));

async function handleMcp(req, res) {
  const ctx = resolveContext(req);

  if (!ctx) {
    // Point the client at our metadata (RFC 9728) so it can find the sign-in
    // service instead of guessing.
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="ajems", resource_metadata="${originOf(req, PUBLIC_URL)}/.well-known/oauth-protected-resource/mcp"`
    );
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Missing or invalid credentials" },
      id: null,
    });
  }

  // Every authenticated request marks its session as alive — this is what
  // keeps a real connector heartbeating and lets an abandoned one go dormant.
  const header = req.headers.authorization || "";
  const rawToken = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.params?.token || req.query?.key || null);
  if (rawToken) touchSession(rawToken);

  // initialize names the calling client. Sessions signed in before client
  // detection existed get identified and stamped here, then start reporting
  // to their one endpoint. Cheap, and skipped for every other method.
  if (req.body?.method === "initialize") {
    linkOrg(ctx.tenant, ctx.secretKey);
    const client = detectClient(req.body?.params?.clientInfo?.name);
    // Report once, when the session is first stamped with its client.
    if (client) {
      noteClient(ctx.tenant, req.body?.params?.clientInfo?.name);
      if (rawToken && setSessionClient(rawToken, client)) reportClient(ctx.tenant, client);
    }
  }

  if (rateLimited((req.headers.authorization || "").slice(-24))) {
    return res.status(429).json({
      jsonrpc: "2.0",
      error: { code: -32029, message: `Rate limit reached (${RATE_LIMIT} calls/min). Try again shortly.` },
      id: null,
    });
  }

  const audit = (tool, args, rows) => console.log(JSON.stringify({
    ts: new Date().toISOString(),
    tenant: ctx.tenant,
    user: ctx.user,
    tool,
    args,
    rows,
  }));

  // A fresh server per request: the tenant is fixed at construction, so two
  // tenants' requests can never share state.
  const mcp = buildServer(ctx, audit);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    mcp.close();
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
}

app.post("/mcp", handleMcp);
app.post("/mcp/:token", handleMcp);   // token in the path, for clients with no header field
app.post("/", handleMcp);             // tolerate a connector registered without /mcp

// Unlink this workspace. Authenticated by the caller's own bearer token, so it
// reuses the existing session store rather than adding a second one.
app.post("/unlink", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.query?.key || null);
  if (!token) return res.status(401).json({ error: "Missing credentials" });

  const result = revokeSession(token);
  if (!result) return res.status(401).json({ error: "Unknown or already revoked token" });

  disconnectOrg(result.tenant, result.client, result.remaining);
  console.log(`[oauth] unlinked "${result.tenant}"`);
  res.json({ unlinked: true });
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));
app.delete("/mcp", (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || e));

const httpServer = app.listen(PORT, () => {
  console.log(`AJEMS MCP server listening on port ${PORT}`);
  console.log(`Working dir:   ${process.cwd()}`);
  console.log(`Config file:   ${ENV_PATH} ${ENV_FOUND ? "(loaded)" : "*** NOT FOUND — defaults in use ***"}`);
  console.log(`Connector URL:  ${PUBLIC_URL}/mcp`);
  console.log(`Tenant pattern: ${HOST_TEMPLATE}`);
  console.log(`Tools: ${toolCount()} | Writes: ${ALLOW_WRITES ? "ENABLED" : "DISABLED"}`);
  if (!ALLOW_WRITES) {
    console.log("  -> Only the 7 read tools are being served.");
    console.log(`  -> To enable the 6 write tools set ALLOW_WRITES=true in .env and restart. Currently ALLOW_WRITES=${JSON.stringify(process.env.ALLOW_WRITES ?? "(not set)")}`);
  }
});

// Re-link organisations from sessions restored at startup, then start
// reporting. No one has to sign in again after a restart.
seedLinkedOrgs(allSessions());
startConnectorHeartbeat(allSessions);

// Should exceed nginx's own timeouts to avoid mid-request resets.
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`${signal} received, finishing in-flight requests...`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

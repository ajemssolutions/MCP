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

import "dotenv/config";
import express from "express";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mountOAuth, lookupSession, sessionCount } from "./oauth.js";
import { getWorkspaceConfig, flattenForms } from "./ajems.js";
import { buildServer, toolCount } from "./tools.js";
import { cacheStats, limiterStats } from "./cache.js";
import { originOf, envFlag } from "./util.js";

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
// Authentication — the security boundary
//
// Credentials are verified against the live API before any token is issued, so
// a wrong key never produces a working session.
// ---------------------------------------------------------------------------

async function verifyCredentials(organisation, secretKey) {
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

mountOAuth(app, { publicUrl: PUBLIC_URL, verifyCredentials });

app.get("/health", (_req, res) => res.json({
  ok: true,
  mode: "multi-tenant",
  tools: toolCount,
  writes: ALLOW_WRITES,
  sessions: sessionCount(),
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

app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));
app.delete("/mcp", (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || e));

const httpServer = app.listen(PORT, () => {
  console.log(`AJEMS MCP server listening on port ${PORT}`);
  console.log(`Connector URL:  ${PUBLIC_URL}/mcp`);
  console.log(`Tenant pattern: ${HOST_TEMPLATE}`);
  console.log(`Tools: ${toolCount} | Writes: ${ALLOW_WRITES ? "ENABLED" : "DISABLED"}`);
  if (!ALLOW_WRITES) {
    console.log("  -> Only the 7 read tools are being served.");
    console.log(`  -> To enable the 6 write tools set ALLOW_WRITES=true in .env and restart. Currently ALLOW_WRITES=${JSON.stringify(process.env.ALLOW_WRITES ?? "(not set)")}`);
  }
});

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
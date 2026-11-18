// config.js — every setting, read once. Loads .env (next to this file) on a normal server;
// on Vercel the settings come from the project's Environment Variables.
//
// The same code serves staging and live: only these settings differ between the two Vercel
// projects (ajems-mcp-connector-staging → the staging server, ajems-mcp-connector → live).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A tiny .env reader (no package): KEY=value lines, # comments, optional quotes.
// Values already in the environment win, as with dotenv.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}
export const ENV_FOUND = loadDotEnv(path.join(HERE, ".env"));

const env = (name, fallback = "") => (process.env[name] ?? fallback).toString().trim();
const flag = (name, fallback) => {
  const v = env(name, "").toLowerCase().replace(/^["']|["']$/g, "");
  return v === "" ? fallback : ["1", "true", "yes", "on"].includes(v);
};

export const config = {
  port: Number(env("PORT", "8080")),
  // This connector's public address, no trailing slash. People add  <PUBLIC_URL>/mcp  in Claude / ChatGPT.
  // On Vercel, when PUBLIC_URL is not set, the project's own production address is used.
  publicUrl: env("PUBLIC_URL", process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:8080").replace(/\/+$/, ""),
  // Where an organisation's AJEMS lives. {org} is the workspace name the person types.
  //   staging:  API https://{org}.api.ajems-staging.com   website https://{org}.ajems-staging.com
  //   live:     API https://{org}.buildprohub-server.com  website https://{org}.ajems.in
  apiTemplate: env("AJEMS_API_TEMPLATE", "https://{org}.api.ajems-staging.com"),
  webTemplate: env("AJEMS_WEB_TEMPLATE", "https://{org}.ajems-staging.com"),
  // Shared with Backend/.env AJEN_MCP_SERVER_SECRET: proves to AJEMS that the code swap is this connector.
  serverSecret: env("AJEMS_SERVER_SECRET"),
  // 64 hex characters (openssl rand -hex 32): seals the tokens Claude / ChatGPT hold and the sign-in steps.
  sessionKey: env("SESSION_KEY"),
  // A label shown on the sign-in page ("Staging") so testers never confuse the two.
  envLabel: env("ENV_LABEL", ""),
  // Where Claude / ChatGPT may receive a sign-in code. An entry ending in * allows that prefix.
  allowedRedirects: env("ALLOWED_REDIRECT_URIS",
    "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback," +
    "https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/*")
    .split(",").map((u) => u.trim()).filter(Boolean),
  allowLocalRedirects: flag("ALLOW_LOCAL_REDIRECTS", true),
  upstreamTimeoutMs: Number(env("UPSTREAM_TIMEOUT_MS", "60000")),
  buildTimeoutMs: Number(env("BUILD_TIMEOUT_MS", "120000")),
  signInPerIpPerHour: Number(env("SIGNIN_PER_IP_PER_HOUR", "60")),
  // Upstash Redis (Vercel: Storage › Upstash for Redis). Optional: makes sign-in codes and
  // write confirmations single-use across Vercel instances. Without it they are single-use per instance.
  redisUrl: env("KV_REST_API_URL", env("UPSTASH_REDIS_REST_URL")).replace(/\/$/, ""),
  redisToken: env("KV_REST_API_TOKEN", env("UPSTASH_REDIS_REST_TOKEN")),
};

/** What is missing for the connector to work at all (shown on /health and at start). */
export function problems() {
  const out = [];
  if (!/^[0-9a-f]{64}$/i.test(config.sessionKey)) out.push("SESSION_KEY must be 64 hex characters (openssl rand -hex 32)");
  if (config.serverSecret.length < 16) out.push("AJEMS_SERVER_SECRET is missing (the same value as AJEN_MCP_SERVER_SECRET in Backend/.env)");
  if (!config.apiTemplate.includes("{org}") || !config.webTemplate.includes("{org}")) out.push("AJEMS_API_TEMPLATE and AJEMS_WEB_TEMPLATE need {org}");
  if (!/^https?:\/\//.test(config.publicUrl)) out.push("PUBLIC_URL must be this connector's address");
  if (process.env.VERCEL && /localhost|127\.0\.0\.1/.test(config.publicUrl)) out.push("PUBLIC_URL is not set: set it to this project's https address (e.g. https://ajems-mcp-connector-staging.vercel.app)");
  if (/\/mcp$/i.test(config.publicUrl)) out.push("PUBLIC_URL must NOT end with /mcp (use https://<your address> only; people add <PUBLIC_URL>/mcp)");
  return out;
}

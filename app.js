// app.js — every address of the connector, as one Node request handler (no packages).
// server.js runs it on a normal server; api/index.js runs it on Vercel.

import { config, problems } from "./config.js";
import { mcpPost } from "./mcp.js";
import { authorizationServer, authorizeGet, authorizePost, callback, protectedResource, register, token } from "./oauth.js";
import { store } from "./store.js";

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

// Claude and ChatGPT call the OAuth and MCP addresses from their own servers; a browser only
// opens /authorize and /oauth/callback. CORS stays open for the JSON addresses (no cookies are used).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

export async function handler(req, res) {
  const url = new URL(req.url, config.publicUrl);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const query = Object.fromEntries(url.searchParams);
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    switch (`${req.method} ${path}`) {
      case "GET /":
        return send(res, 200, { name: "AJEMS connector", mcp: `${config.publicUrl}/mcp` });
      case "GET /health": {
        const missing = problems();
        return send(res, missing.length ? 503 : 200, { ok: !missing.length, version: "5.0.2", env: config.envLabel || undefined,
          public_url: config.publicUrl, connector_url: `${config.publicUrl}/mcp`,
          store: store.kind, ajems_api: config.apiTemplate, ajems_web: config.webTemplate, problems: missing });
      }
      case "GET /.well-known/oauth-protected-resource":
      case "GET /.well-known/oauth-protected-resource/mcp":
        return protectedResource(res);
      case "GET /.well-known/oauth-authorization-server":
      case "GET /.well-known/oauth-authorization-server/mcp":
      case "GET /.well-known/openid-configuration":
        return authorizationServer(res);
      case "POST /register":
        return await register(req, res);
      case "GET /authorize":
        return authorizeGet(req, res, query);
      case "POST /authorize":
        return await authorizePost(req, res);
      case "GET /oauth/callback":
        return await callback(req, res, query);
      case "POST /token":
        return await token(req, res);
      case "POST /mcp":
        return await mcpPost(req, res);
      case "GET /mcp":
        return send(res, 405, { error: "Use POST for MCP requests" }, { Allow: "POST" });
      case "DELETE /mcp":
        return send(res, 204, "");
      default:
        return send(res, 404, { error: "not found" });
    }
  } catch (e) {
    console.error(`[http] ${req.method} ${path} failed:`, e);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  }
}

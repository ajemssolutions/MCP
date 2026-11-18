// mcp.js — the Model Context Protocol over HTTP (JSON-RPC 2.0, "Streamable HTTP" with plain
// JSON replies; no session needed). The tools, their descriptions and who may use which all
// come from AJEMS (/ajen/mcp/me/): this file only passes calls through, as the signed-in person.
//
// The one rule kept here as well: a confirmation_id works ONCE (AJEMS signs it for exactly
// that content and 10 minutes; this connector makes sure it is not replayed).

import { config } from "./config.js";
import { me, tool, Refused, SignedOut } from "./ajems.js";
import { contextOf, readBody } from "./oauth.js";
import { sha256 } from "./seal.js";
import { store } from "./store.js";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "5.0.2";

const INSTRUCTIONS = `You are connected to AJEMS (a no-code operations platform) as the signed-in person, with exactly their permissions.
- Start with list_apps_and_forms when you do not know which form a question is about, then show_form_fields before filtering, counting or summarising.
- Never count or add up records yourself: use count_records and summarise_records (computed by AJEMS over every record). find_records shows a page; total_matching_records is the true count.
- Something the person cannot open is answered as if it does not exist: say plainly that it is not among their apps or forms.
- Adding records, creating an app and saving a flow are always two steps: preview, show the person exactly what will happen, and only after they clearly agree call again with the confirmation_id. Never confirm on your own.
- Building (apps and flows) is only for the workspace owner: ask a few questions first, show the design, change it as asked.`;

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

class NeedsSignIn extends Error {}

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}),
           ...(!isError && value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}) };
}

/** A write's confirmation may be used once (AJEMS checks the rest). */
function confirmationOf(name, args) {
  if (!args || typeof args.confirmation_id !== "string" || !args.confirmation_id) return null;
  if (name === "add_records" && args.confirm !== true) return null;
  return ["add_records", "create_app", "save_flow"].includes(name) ? args.confirmation_id : null;
}

async function handle(ctx, msg) {
  const { id, method, params } = msg || {};
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return rpcError(id, -32600, "Invalid Request");
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ajems", title: "AJEMS", version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return rpcResult(id, {});
      case "tools/list": {
        const who = await me(ctx);
        return rpcResult(id, { tools: (who.tools || []).map(({ name, title, description, inputSchema, annotations }) =>
          ({ name, title, description, inputSchema, annotations })) });
      }
      case "tools/call": {
        const name = String(params?.name || "");
        const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
        const confirmation = confirmationOf(name, args);
        if (confirmation && !(await store.claim(`confirm:${sha256(confirmation)}`, 900))) {
          return rpcResult(id, textResult("This confirmation_id was already used. Preview again and ask the person to confirm.", true));
        }
        const started = Date.now();
        try {
          const out = await tool(ctx, name, args);
          console.log(`[tool] org=${ctx.org} tool=${name} ok ms=${Date.now() - started}`);
          return rpcResult(id, textResult(out.result));
        } catch (e) {
          if (e instanceof Refused) {
            console.log(`[tool] org=${ctx.org} tool=${name} refused=${e.status} ms=${Date.now() - started}`);
            return rpcResult(id, textResult(e.message, true));
          }
          throw e;
        }
      }
      default:
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (e instanceof SignedOut) throw new NeedsSignIn(e.message);
    if (e instanceof Refused) return rpcError(id, -32000, e.message);
    console.error(`[mcp] ${method} failed:`, e);
    return rpcError(id, -32603, "Internal error");
  }
}

function signInNeeded(res, description = "Sign in to AJEMS") {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description.replace(/"/g, "'")}"`,
  });
  res.end(JSON.stringify({ error: "invalid_token", error_description: description }));
}

export async function mcpPost(req, res) {
  const ctx = contextOf(req.headers.authorization);
  if (!ctx) return signInNeeded(res);
  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(413, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(rpcError(null, -32700, "Body too large")));
  }
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  if (!messages.length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(rpcError(null, -32600, "Empty batch")));
  }
  let replies;
  try {
    replies = (await Promise.all(messages.map((m) => handle(ctx, m)))).filter(Boolean);
  } catch (e) {
    if (e instanceof NeedsSignIn) return signInNeeded(res, "Your AJEMS sign-in has ended. Sign in again.");
    throw e;
  }
  if (!replies.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(batch ? replies : replies[0]));
}

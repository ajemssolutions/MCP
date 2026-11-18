// ajems.js — the only module that talks to AJEMS. Every call goes to the workspace the person
// signed in to (the org sealed in their token), as that person, and AJEMS decides everything:
// who may use it, which apps, forms, records and fields, what may be added or built.

import { config } from "./config.js";

export class SignedOut extends Error {}        // AJEMS refused the token: sign in again
export class Refused extends Error {           // AJEMS said no (permission, not found, bad input)
  constructor(message, status) { super(message); this.status = status; }
}

/** A workspace name as typed → the subdomain-safe name, or "" when it cannot be one. */
export function orgName(raw) {
  const org = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(org) ? org : "";
}

export const apiBase = (org) => config.apiTemplate.replace("{org}", org).replace(/\/+$/, "");
export const webBase = (org) => config.webTemplate.replace("{org}", org).replace(/\/+$/, "");

async function call(url, { method = "GET", token, body, headers = {}, timeout = config.upstreamTimeoutMs } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}),
                 ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Refused(e.name === "TimeoutError" ? "AJEMS took too long to answer. Try again." :
      "AJEMS could not be reached. Check the workspace name, or try again shortly.", 502);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new SignedOut(data.detail || data.error || "signed out");
  if (!res.ok) throw new Refused(String(data.error || data.detail || data.error_description || `AJEMS answered ${res.status}`), res.status);
  return data;
}

/** The connector's code swap (server to server, with the shared secret and the PKCE verifier). */
export const swapCode = (org, { code, verifier, redirectUri }) => call(`${apiBase(org)}/ajen/mcp/token/`, {
  method: "POST", headers: { "X-Ajen-Mcp-Secret": config.serverSecret },
  body: { code, code_verifier: verifier, redirect_uri: redirectUri },
});

/** Who is signed in, and the tools this person may use. */
export const me = (ctx) => call(`${apiBase(ctx.org)}/ajen/mcp/me/`, { token: ctx.token });

const SLOW = new Set(["create_app", "save_flow"]);

/** Run one tool as the signed-in person. */
export const tool = (ctx, name, args) => call(`${apiBase(ctx.org)}/ajen/mcp/tool/`, {
  method: "POST", token: ctx.token, body: { name, arguments: args || {} },
  timeout: SLOW.has(name) ? config.buildTimeoutMs : config.upstreamTimeoutMs,
});

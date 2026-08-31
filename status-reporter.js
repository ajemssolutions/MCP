// status-reporter.js — reports this connector's status to the AJEMS Connector Store.
//
// Everything here is BEST EFFORT. No function throws, none is awaited on a
// request path, and a failed report is a log line and nothing more. If the
// Connector Store is down, misconfigured, or returns 401, the MCP server keeps
// serving tools exactly as it did before.
//
// This module holds no credentials of its own: `register` is handed the same
// session context oauth.js already stores, and the secret key is used only as
// the request body the Store asks for. It is never logged, never placed in a
// URL, and never sent anywhere but the configured HTTPS endpoint.

import { envFlag } from "./util.js";

const REPORT_URL = process.env.CONNECTOR_STORE_REPORT_URL
  || "https://connectors.ajems.com/api/connectors/claude/report";

const ENABLED = envFlag("STATUS_REPORTING", true);
const TIMEOUT_MS = Number(process.env.STATUS_REPORT_TIMEOUT_MS || 10_000);
const HEARTBEAT_MS = Number(process.env.STATUS_HEARTBEAT_MS || 5 * 60 * 1000);
const EVENT_THROTTLE_MS = Number(process.env.STATUS_EVENT_THROTTLE_MS || 60_000);

/**
 * HTTPS only. Plain http is permitted for loopback alone, so the mock and the
 * local test harness still work; that traffic never leaves the machine.
 */
function endpointUsable(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.warn("[status] CONNECTOR_STORE_REPORT_URL is not a valid URL — status reporting is off.");
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.host.split(":")[0])) {
    console.warn("[status] reporting to a loopback address over http (local testing only).");
    return true;
  }
  console.warn("[status] CONNECTOR_STORE_REPORT_URL must be https — status reporting is off.");
  return false;
}

const USABLE = ENABLED && endpointUsable(REPORT_URL);

// org -> { org, secretKey, connectedBy, lastEventAt }
// One entry per organisation: the Store keeps a single Claude connection each,
// so several sessions on one workspace collapse to one linked entry.
const linked = new Map();

export const linkedCount = () => linked.size;

/**
 * The Store's `connectedBy` is a user email. Sessions carry `user`, which is
 * the org name for OAuth sign-ins, so only send it when it really is an email.
 */
const emailOrNull = (value) => (typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null);

/** Note a linked workspace without reporting. Used when sessions load at boot. */
export function register(ctx) {
  if (!USABLE || !ctx?.tenant || !ctx?.secretKey) return;
  const existing = linked.get(ctx.tenant);
  linked.set(ctx.tenant, {
    org: ctx.tenant,
    secretKey: ctx.secretKey,
    connectedBy: emailOrNull(ctx.user) || existing?.connectedBy || null,
    lastEventAt: existing?.lastEventAt || 0,
  });
}

export function forget(org) {
  linked.delete(org);
}

/**
 * The single outbound call. Resolves to true or false, never rejects.
 * The body is never logged — it carries the workspace secret key.
 */
async function post(body, label) {
  if (!USABLE) return false;
  try {
    const res = await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Drain the body so the socket is released, then discard it.
    await res.text().catch(() => "");
    if (!res.ok) {
      console.warn(`[status] ${label} for "${body.org}" -> HTTP ${res.status} (ignored)`);
      return false;
    }
    console.log(`[status] ${label} for "${body.org}" -> ok`);
    return true;
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? `no response within ${TIMEOUT_MS / 1000}s` : e?.message || "unknown error";
    console.warn(`[status] ${label} for "${body.org}" failed: ${reason} (ignored)`);
    return false;
  }
}

/** Fire and forget: never awaited by a caller on a request path. */
function send(body, label) {
  if (!USABLE) return;
  void post(body, label);
}

function payload(entry, extra = {}) {
  return {
    org: entry.org,
    secretKey: entry.secretKey,
    status: "connected",
    ...(entry.connectedBy ? { connectedBy: entry.connectedBy } : {}),
    records: 0,
    ...extra,
  };
}

/** Called the moment a workspace is linked, straight after the token is issued. */
export function reportConnected(ctx) {
  register(ctx);
  const entry = linked.get(ctx?.tenant);
  if (!entry) return;
  send(payload(entry, { event: { kind: "ok", text: "Claude MCP connected" } }), "connected");
}

/** Called when the last session for a workspace goes away. */
export function reportDisconnected(org) {
  const entry = linked.get(org);
  if (!entry) return;
  forget(org);
  send({
    org: entry.org,
    secretKey: entry.secretKey,
    status: "disconnected",
    ...(entry.connectedBy ? { connectedBy: entry.connectedBy } : {}),
    records: 0,
    event: { kind: "ok", text: "Claude MCP disconnected" },
  }, "disconnected");
}

/**
 * Optional event after real tool activity. Throttled per organisation, so a
 * model writing fifty records in a loop produces one report, not fifty.
 */
export function reportEvent(ctx, { kind = "ok", text, records = 0 } = {}) {
  if (!USABLE || !text) return;
  register(ctx);
  const entry = linked.get(ctx?.tenant);
  if (!entry) return;

  const now = Date.now();
  if (now - entry.lastEventAt < EVENT_THROTTLE_MS) return;
  entry.lastEventAt = now;

  send(payload(entry, { records, event: { kind, text } }), `event "${text}"`);
}

// --- heartbeat --------------------------------------------------------------
// Keeps every linked organisation showing as Online. Stop the server and the
// reports stop with it, so the Store's own timeout marks it Offline.

let timer = null;

async function beat() {
  for (const entry of [...linked.values()]) {
    await post(payload(entry), "heartbeat");   // sequential: no burst across tenants
  }
}

export function startHeartbeat() {
  if (!USABLE || timer) return;
  void beat();                                  // report restored sessions immediately
  timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref();                                // never holds the process open
  console.log(`[status] reporting to ${new URL(REPORT_URL).origin}, heartbeat every ${HEARTBEAT_MS / 60000} min`);
}

export function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}

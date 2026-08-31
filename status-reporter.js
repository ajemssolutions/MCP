// status-reporter.js — reports this connector's status to the AJEMS Connector Store.
//
// The MCP server is client-agnostic: Claude, ChatGPT and Gemini all speak to it.
// The Store keeps one connection per AI per organisation, so every report is
// routed to /api/connectors/{ai}/report and the registry is keyed by both.
//
// Everything here is BEST EFFORT. No function throws, none is awaited on a
// request path, and a failed report is a log line and nothing more.
//
// This module holds no credentials of its own: `register` is handed the same
// session context oauth.js already stores, and the secret key is used only as
// the request body the Store asks for. It is never logged, never placed in a
// URL, and never sent anywhere but the configured HTTPS endpoint.

// config.js loads .env and owns envFlag. Importing it here also guarantees the
// environment is populated before the constants below are evaluated.
import { envFlag } from "./config.js";

const REPORT_URL_TEMPLATE = process.env.CONNECTOR_STORE_REPORT_URL
  || "https://connectors.ajems.com/api/connectors/{ai}/report";

const ENABLED = envFlag("STATUS_REPORTING", true);
const TIMEOUT_MS = Number(process.env.STATUS_REPORT_TIMEOUT_MS || 10_000);
const HEARTBEAT_MS = Number(process.env.STATUS_HEARTBEAT_MS || 5 * 60 * 1000);
const EVENT_THROTTLE_MS = Number(process.env.STATUS_EVENT_THROTTLE_MS || 60_000);

/**
 * Fallback for sessions with no AI recorded — the ones signed in before client
 * detection existed. Without it they never report and the Store shows nothing
 * until each user reconnects. It is a guess, so it is off unless set, and it is
 * dropped the moment the MCP handshake tells us what the client really is.
 */
const ASSUMED_CLIENT = (process.env.STATUS_ASSUME_CLIENT || "").trim().toLowerCase() || null;

/** The AIs the Connector Store has a page for. */
export const KNOWN_CLIENTS = ["claude", "chatgpt", "gemini"];

/**
 * Signals that identify the calling AI, strongest first. Redirect URIs are the
 * most reliable — each vendor's platform fixes them — so they are checked
 * before the free-text name a client registers itself under.
 */
const HOST_SIGNALS = [
  [/(^|\.)claude\.(ai|com)$/i, "claude"],
  [/(^|\.)anthropic\.com$/i, "claude"],
  [/(^|\.)chatgpt\.com$/i, "chatgpt"],
  [/(^|\.)openai\.com$/i, "chatgpt"],
  [/(^|\.)gemini\.google\.com$/i, "gemini"],
  [/(^|\.)google\.com$/i, "gemini"],
  [/(^|\.)googleusercontent\.com$/i, "gemini"],
];

const NAME_SIGNALS = [
  [/claude|anthropic/i, "claude"],
  [/chatgpt|openai|gpt/i, "chatgpt"],
  [/gemini|bard|google/i, "gemini"],
];

const hostOf = (uri) => { try { return new URL(uri).hostname; } catch { return null; } };

function matchName(value) {
  if (!value) return null;
  for (const [pattern, client] of NAME_SIGNALS) if (pattern.test(value)) return client;
  return null;
}

/**
 * Work out which AI is talking to us. Returns "claude" | "chatgpt" | "gemini",
 * or null when nothing matched — callers must handle null rather than guess,
 * because a wrong guess puts a workspace on the wrong Store page.
 */
export function identifyClient({ redirectUri, clientName, mcpClientName, userAgent } = {}) {
  const host = hostOf(redirectUri);
  if (host) {
    for (const [pattern, client] of HOST_SIGNALS) if (pattern.test(host)) return client;
  }
  // mcpClientName comes from the MCP initialize handshake; clientName is what
  // the client registered itself as during dynamic client registration.
  return matchName(mcpClientName) || matchName(clientName) || matchName(userAgent) || null;
}

/** HTTPS only. Loopback over http is allowed so the local test harness works. */
function endpointUsable(raw) {
  let url;
  try {
    url = new URL(String(raw).replace("{ai}", "claude"));
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

const USABLE = ENABLED && endpointUsable(REPORT_URL_TEMPLATE);

const endpointFor = (client) =>
  REPORT_URL_TEMPLATE.includes("{ai}")
    ? REPORT_URL_TEMPLATE.replace("{ai}", encodeURIComponent(client))
    : REPORT_URL_TEMPLATE;   // legacy single-AI URL

// "claude:kathaa" -> { client, org, secretKey, connectedBy, lastEventAt }
const linked = new Map();
const keyOf = (client, org) => `${client}:${org}`;

export const linkedCount = () => linked.size;
export const linkedSummary = () =>
  [...linked.values()].map(({ client, org, assumed }) => ({ ai: client, org, ...(assumed ? { assumed: true } : {}) }));

/**
 * The Store's `connectedBy` is a user email. Sessions carry `user`, which is
 * the org name for OAuth sign-ins, so only send it when it really is an email.
 */
const emailOrNull = (v) => (typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null);

/** Note a linked workspace without reporting. Used when sessions load at boot. */
export function register(ctx) {
  if (!USABLE || !ctx?.tenant || !ctx?.secretKey) return null;

  const identified = KNOWN_CLIENTS.includes(ctx.client);
  const client = identified ? ctx.client
    : (KNOWN_CLIENTS.includes(ASSUMED_CLIENT) ? ASSUMED_CLIENT : null);
  if (!client) return null;   // unidentified and no fallback: nothing to route to

  const key = keyOf(client, ctx.tenant);
  const existing = linked.get(key);
  const entry = {
    client,
    org: ctx.tenant,
    secretKey: ctx.secretKey,
    connectedBy: emailOrNull(ctx.user) || existing?.connectedBy || null,
    lastEventAt: existing?.lastEventAt || 0,
    // A real identification always wins over an earlier assumption.
    assumed: identified ? false : (existing?.assumed ?? true),
  };
  linked.set(key, entry);
  return entry;
}

/**
 * Once the handshake tells us the real AI, retire any entry for this workspace
 * that only existed because of STATUS_ASSUME_CLIENT and named a DIFFERENT one.
 * Entries we genuinely identified are left alone, so a real second client on
 * the same workspace is never knocked offline by someone else's correction.
 * The matching entry is kept: reportConnected re-registers it as identified,
 * which avoids a pointless disconnect/connect flap.
 */
export function dropAssumedExcept(org, keepClient) {
  let dropped = 0;
  for (const entry of [...linked.values()]) {
    if (entry.org !== org || !entry.assumed || entry.client === keepClient) continue;
    console.log(`[status] "${org}" was assumed to be ${entry.client}, but it is ${keepClient}; correcting.`);
    reportDisconnected(org, entry.client);
    dropped++;
  }
  return dropped;
}

export function forget(org, client = null) {
  for (const [key, entry] of linked) {
    if (entry.org === org && (!client || entry.client === client)) linked.delete(key);
  }
}

/**
 * The single outbound call. Resolves to true or false, never rejects.
 * The body is never logged — it carries the workspace secret key.
 */
async function post(entry, body, label) {
  if (!USABLE) return false;
  try {
    const res = await fetch(endpointFor(entry.client), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.text().catch(() => "");   // release the socket, discard the body
    if (!res.ok) {
      console.warn(`[status] ${label} ${entry.client}/"${entry.org}" -> HTTP ${res.status} (ignored)`);
      return false;
    }
    console.log(`[status] ${label} ${entry.client}/"${entry.org}" -> ok`);
    return true;
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? `no response within ${TIMEOUT_MS / 1000}s` : e?.message || "unknown error";
    console.warn(`[status] ${label} ${entry.client}/"${entry.org}" failed: ${reason} (ignored)`);
    return false;
  }
}

/** Fire and forget: never awaited by a caller on a request path. */
function send(entry, body, label) {
  if (!USABLE) return;
  void post(entry, body, label);
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

const nameOf = (client) => ({ claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini" }[client] || client);

/** Called the moment a workspace is linked, and again if the AI is re-identified. */
export function reportConnected(ctx) {
  const entry = register(ctx);
  if (!entry) {
    if (USABLE && ctx?.tenant) {
      console.warn(`[status] "${ctx.tenant}" linked but the AI client could not be identified — not reported yet.`);
      console.warn("[status] set STATUS_ASSUME_CLIENT=claude to report sessions that predate client detection.");
    }
    return;
  }
  send(entry, payload(entry, { event: { kind: "ok", text: `${nameOf(entry.client)} MCP connected` } }), "connected");
}

/** Called when the last session for a workspace goes away. */
export function reportDisconnected(org, client = null) {
  const going = [...linked.values()].filter((e) => e.org === org && (!client || e.client === client));
  forget(org, client);
  for (const entry of going) {
    send(entry, {
      org: entry.org,
      secretKey: entry.secretKey,
      status: "disconnected",
      ...(entry.connectedBy ? { connectedBy: entry.connectedBy } : {}),
      records: 0,
      event: { kind: "ok", text: `${nameOf(entry.client)} MCP disconnected` },
    }, "disconnected");
  }
}

/**
 * Optional event after real tool activity. Throttled per AI per organisation,
 * so a model writing fifty records in a loop produces one report, not fifty.
 */
export function reportEvent(ctx, { kind = "ok", text, records = 0 } = {}) {
  if (!USABLE || !text) return;
  const entry = register(ctx);
  if (!entry) return;

  const now = Date.now();
  if (now - entry.lastEventAt < EVENT_THROTTLE_MS) return;
  entry.lastEventAt = now;

  send(entry, payload(entry, { records, event: { kind, text } }), `event "${text}"`);
}

// --- heartbeat --------------------------------------------------------------
// Keeps every linked organisation showing as Online. Stop the server and the
// reports stop with it, so the Store's own timeout marks it Offline.

let timer = null;

async function beat() {
  for (const entry of [...linked.values()]) {
    await post(entry, payload(entry), "heartbeat");   // sequential: no burst
  }
}

export function startHeartbeat() {
  if (!USABLE || timer) return;
  void beat();                                        // report restored sessions at once
  timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref();                                      // never holds the process open
  console.log(`[status] reporting to ${REPORT_URL_TEMPLATE}, heartbeat every ${HEARTBEAT_MS / 60000} min`);
  if (ASSUMED_CLIENT) console.log(`[status] sessions with no recorded AI are assumed to be "${ASSUMED_CLIENT}" until the handshake says otherwise`);
}

export function stopHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}
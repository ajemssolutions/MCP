// apply-connector-report.mjs — adds AJEMS Connector Store reporting to server.js.
//
//   node apply-connector-report.mjs --check   # show what would change, write nothing
//   node apply-connector-report.mjs           # apply, saving *.bak
//
// Every edit is anchored on an exact string, with alternatives where files are
// known to drift. If any anchor is missing NOTHING is written, so a half-patched
// file is impossible. Running it twice is safe.

import fs from "node:fs";

const CHECK = process.argv.includes("--check");
const notes = [];
let failed = false;

function run(file, steps) {
  let out = fs.readFileSync(file, "utf8");
  for (const [label, anchors, replacement, marker] of steps) {
    if (out.includes(marker)) { notes.push(`  skip   ${file}: ${label}`); continue; }
    const candidates = Array.isArray(anchors) ? anchors : [anchors];
    const anchor = candidates.find((c) => out.includes(c));
    if (!anchor) {
      notes.push(`  FAIL   ${file}: ${label} — no anchor matched`);
      for (const c of candidates) notes.push(`           tried: ${c.split("\n")[0].slice(0, 76)}`);
      failed = true;
      continue;
    }
    out = out.replace(anchor, typeof replacement === "function" ? replacement(anchor) : replacement);
    notes.push(`  patch  ${file}: ${label}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole reporting implementation, inserted into server.js as one block.
// ---------------------------------------------------------------------------
const BLOCK = `
// ---------------------------------------------------------------------------
// AJEMS Connector Store reporting  [connector-report:start]
//
// Tells the Connector Store which organisations are currently linked, so each
// one shows as Online. Entirely best effort: every call is fire-and-forget with
// a 10s timeout, and no failure here can affect OAuth, MCP tools or data sync.
//
// The secret key travels only in the POST body — never a URL, query string or
// log line. Logs carry the endpoint name, the org and the HTTP status, nothing else.
// ---------------------------------------------------------------------------

const STORE_BASE = process.env.CONNECTOR_STORE_URL || "https://connectors.ajems.com/api/connectors";
const STORE_ENDPOINTS = {
  claude: \`\${STORE_BASE}/claude/report\`,
  chatgpt: \`\${STORE_BASE}/chatgpt/report\`,
};
const REPORT_TIMEOUT_MS = Number(process.env.CONNECTOR_REPORT_TIMEOUT_MS || 10_000);
const HEARTBEAT_MS = Number(process.env.CONNECTOR_HEARTBEAT_MS || 5 * 60 * 1000);

const linkedOrgs = new Map();   // org -> secretKey
const orgClients = new Map();   // org -> Set of "claude" | "chatgpt"; absent means unknown

/** Which endpoints to report an org to. Unknown client => both, never a guess. */
function targetsFor(org) {
  const known = orgClients.get(org);
  return known?.size ? [...known] : Object.keys(STORE_ENDPOINTS);
}

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
    console.log(\`[connector-report] \${name} org=\${org} status=\${res.status}\`);
    return res.ok;
  } catch (e) {
    const why = e?.name === "TimeoutError" ? "timeout" : (e?.message || "error");
    console.log(\`[connector-report] \${name} org=\${org} status=failed (\${why})\`);
    return false;
  }
}

/** Report one org to every endpoint that applies. Fire and forget. */
function reportOrg(org, extra = {}) {
  const secretKey = linkedOrgs.get(org);
  if (!secretKey) return;
  for (const client of targetsFor(org)) {
    void reportToStore(STORE_ENDPOINTS[client], org, secretKey, extra);
  }
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
    const client = detectClient(session.client);
    if (client) {
      if (!orgClients.has(session.tenant)) orgClients.set(session.tenant, new Set());
      orgClients.get(session.tenant).add(client);
    }
  }
  return linkedOrgs.size;
}

/**
 * Narrow an org to one connector once the MCP handshake names the client.
 * Until this happens the org is reported to both endpoints.
 */
function noteClient(org, name) {
  const client = detectClient(name);
  if (!client || !linkedOrgs.has(org)) return null;
  const known = orgClients.get(org);
  if (known?.size === 1 && known.has(client)) return null;
  orgClients.set(org, new Set([client]));
  console.log(\`[connector-report] org=\${org} identified as \${client}\`);
  return client;
}

/**
 * Report disconnected, then drop the org — but only once no active session for
 * it remains, so one client unlinking does not knock another offline.
 */
function disconnectOrg(org, remainingSessions = []) {
  const secretKey = linkedOrgs.get(org);
  if (!secretKey) return false;
  if (remainingSessions.some((s) => s?.tenant === org)) return false;

  for (const client of targetsFor(org)) {
    void reportToStore(STORE_ENDPOINTS[client], org, secretKey, { status: "disconnected" });
  }
  linkedOrgs.delete(org);
  orgClients.delete(org);
  return true;
}

/** Unconditional 5-minute heartbeat. Keeps every linked org showing Online. */
function startConnectorHeartbeat() {
  const beat = () => { for (const org of linkedOrgs.keys()) reportOrg(org); };
  beat();                                    // report seeded orgs immediately
  setInterval(beat, HEARTBEAT_MS).unref();   // never holds the process open
  console.log(\`[connector-report] heartbeat every \${HEARTBEAT_MS / 60000} min for \${linkedOrgs.size} org(s)\`);
}
// [connector-report:end]
`;

// --- oauth.js ---------------------------------------------------------------
// Two small exports: the session map lives here, and server.js needs to read it
// (to seed at startup) and remove from it (to report disconnected).
const oauthSteps = [
  [
    "export allSessions() and revokeSession()",
    "export const sessionCount = () => Object.keys(sessions).length;",
    `export const sessionCount = () => Object.keys(sessions).length;

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
}`,
    "export const allSessions = () =>",
  ],
];

// --- server.js --------------------------------------------------------------
const serverSteps = [
  [
    "import allSessions / revokeSession",
    [
      'import { mountOAuth, lookupSession, sessionCount } from "./oauth.js";',
      'import { mountOAuth, lookupSession, sessionCount, revokeSession } from "./oauth.js";',
    ],
    'import { mountOAuth, lookupSession, sessionCount, allSessions, revokeSession } from "./oauth.js";',
    'allSessions, revokeSession } from "./oauth.js";',
  ],
  [
    "insert the reporting block",
    [
      "// ---------------------------------------------------------------------------\n// Authentication — the security boundary",
      "async function verifyCredentials(organisation, secretKey) {",
    ],
    (anchor) => `${BLOCK}\n${anchor}`,
    "[connector-report:start]",
  ],
  [
    "link and report on successful verification",
    '  console.log(`[auth] verified "${org}" (${flattenForms(config).length} forms)`);\n  return ctx;',
    `  console.log(\`[auth] verified "\${org}" (\${flattenForms(config).length} forms)\`);

  // Reuse the org and key just verified here — no second lookup, nothing re-asked.
  linkOrg(org, secretKey);
  reportOrg(org);   // best effort, never awaited

  return ctx;`,
    "linkOrg(org, secretKey);",
  ],
  [
    "identify the client from the MCP handshake",
    '  if (rateLimited((req.headers.authorization || "").slice(-24))) {',
    `  // initialize names the calling client, which narrows this org from "both
  // endpoints" to the right one. Cheap, and skipped for every other method.
  if (req.body?.method === "initialize") {
    linkOrg(ctx.tenant, ctx.secretKey);
    if (noteClient(ctx.tenant, req.body?.params?.clientInfo?.name)) reportOrg(ctx.tenant);
  }

  if (rateLimited((req.headers.authorization || "").slice(-24))) {`,
    'if (req.body?.method === "initialize") {',
  ],
  [
    "add linked orgs to /health",
    "  sessions: sessionCount(),",
    "  sessions: sessionCount(),\n  linked_orgs: [...linkedOrgs.keys()].map((org) => ({ org, report_to: targetsFor(org) })),",
    "linked_orgs: [...linkedOrgs.keys()]",
  ],
  [
    "add POST /unlink",
    'app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));',
    `// Unlink this workspace. Authenticated by the caller's own bearer token, so it
// reuses the existing session store rather than adding a second one.
app.post("/unlink", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.query?.key || null);
  if (!token) return res.status(401).json({ error: "Missing credentials" });

  const result = revokeSession(token);
  if (!result) return res.status(401).json({ error: "Unknown or already revoked token" });

  disconnectOrg(result.tenant, result.remaining);
  console.log(\`[oauth] unlinked "\${result.tenant}"\`);
  res.json({ unlinked: true });
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));`,
    'app.post("/unlink"',
  ],
  [
    "seed from saved sessions and start the heartbeat",
    "// Should exceed nginx's own timeouts to avoid mid-request resets.",
    `// Re-link organisations from sessions restored at startup, then start
// reporting. No one has to sign in again after a restart.
seedLinkedOrgs(allSessions());
startConnectorHeartbeat();

// Should exceed nginx's own timeouts to avoid mid-request resets.`,
    "seedLinkedOrgs(allSessions());",
  ],
];

const oauth = run("oauth.js", oauthSteps);
const server = run("server.js", serverSteps);

console.log(notes.join("\n"));

if (failed) {
  console.error("\nOne or more anchors were not found. Nothing was written.");
  process.exit(1);
}
if (CHECK) {
  console.log("\n--check: nothing written.");
  process.exit(0);
}

for (const [file, content] of [["oauth.js", oauth], ["server.js", server]]) {
  if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, content);
}
console.log("\nDone. Originals saved as oauth.js.bak and server.js.bak. Restart the server.");

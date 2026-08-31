// apply-status-reporting.mjs — wires status-reporter.js into the existing server.
//
//   node apply-status-reporting.mjs           # apply
//   node apply-status-reporting.mjs --check   # report what would change, touch nothing
//
// Every edit is anchored on an exact string. If an anchor is missing the script
// stops and changes nothing, rather than half-patching a file. Running it twice
// is safe: edits already present are skipped.

import fs from "node:fs";

const CHECK = process.argv.includes("--check");
const edits = [];
let failed = false;

function patch(file, label, anchor, replacement, marker) {
  const before = fs.readFileSync(file, "utf8");
  if (before.includes(marker)) {
    edits.push(`  skip   ${file}: ${label} (already applied)`);
    return before;
  }
  if (!before.includes(anchor)) {
    edits.push(`  FAIL   ${file}: ${label} — anchor not found`);
    failed = true;
    return before;
  }
  edits.push(`  patch  ${file}: ${label}`);
  return before.replace(anchor, replacement);
}

// --- oauth.js ---------------------------------------------------------------
let oauth = fs.readFileSync("oauth.js", "utf8");
const oauthSteps = [
  [
    "import the reporter",
    'import { originOf } from "./util.js";',
    'import { originOf } from "./util.js";\nimport { register, reportConnected, reportDisconnected } from "./status-reporter.js";',
    './status-reporter.js";',
  ],
  [
    "re-link restored sessions at boot",
    "    console.log(`Loaded ${Object.keys(sessions).length} saved session(s)`);",
    "    console.log(`Loaded ${Object.keys(sessions).length} saved session(s)`);\n" +
      "    // Re-link restored workspaces so the heartbeat covers them after a restart.\n" +
      "    for (const session of Object.values(sessions)) register(session);",
    "for (const session of Object.values(sessions)) register(session);",
  ],
  [
    "add revokeSession()",
    "export const sessionCount = () => Object.keys(sessions).length;",
    `export const sessionCount = () => Object.keys(sessions).length;

/**
 * Unlink one session. Reports disconnected only once the LAST session for that
 * workspace is gone, since the Connector Store keeps one Claude connection per
 * organisation. Returns the organisation name, or null if the token was unknown.
 */
export function revokeSession(token) {
  const session = sessions[token];
  if (!session) return null;
  delete sessions[token];
  saveSessions();
  const stillLinked = Object.values(sessions).some((s) => s.tenant === session.tenant);
  if (!stillLinked) reportDisconnected(session.tenant);
  return session.tenant;
}`,
    "export function revokeSession(token) {",
  ],
  [
    "report connected after the token is issued",
    '    console.log(`[oauth] issued token for "${entry.ctx.tenant}"`);',
    '    console.log(`[oauth] issued token for "${entry.ctx.tenant}"`);\n' +
      "    reportConnected(entry.ctx);   // best effort, never awaited",
    "reportConnected(entry.ctx);",
  ],
];
// --- server.js --------------------------------------------------------------
let server = fs.readFileSync("server.js", "utf8");
const serverSteps = [
  [
    "import revokeSession",
    'import { mountOAuth, lookupSession, sessionCount } from "./oauth.js";',
    'import { mountOAuth, lookupSession, sessionCount, revokeSession } from "./oauth.js";',
    "revokeSession } from \"./oauth.js\";",
  ],
  [
    "import the reporter",
    'import { cacheStats, limiterStats } from "./cache.js";',
    'import { cacheStats, limiterStats } from "./cache.js";\nimport { startHeartbeat, linkedCount } from "./status-reporter.js";',
    'from "./status-reporter.js";',
  ],
  [
    "expose the raw bearer token",
    `function resolveContext(req) {
  const header = req.headers.authorization || "";
  const raw = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : (req.params?.token || req.query?.key || null);
  if (!raw) return null;
  return lookupSession(raw) || devTokens.get(raw) || null;
}`,
    `function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : (req.params?.token || req.query?.key || null);
}

function resolveContext(req) {
  const raw = bearerToken(req);
  if (!raw) return null;
  return lookupSession(raw) || devTokens.get(raw) || null;
}`,
    "function bearerToken(req) {",
  ],
  [
    "add linked_orgs to /health",
    "  sessions: sessionCount(),",
    "  sessions: sessionCount(),\n  linked_orgs: linkedCount(),",
    "linked_orgs: linkedCount(),",
  ],
  [
    "add POST /unlink",
    'app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));',
    `/**
 * Unlink this workspace. Authenticated by the caller's own bearer token, so it
 * reuses the existing session store rather than introducing a second one.
 */
app.post("/unlink", (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Missing credentials" });
  const org = revokeSession(token);
  if (!org) return res.status(401).json({ error: "Unknown or already revoked token" });
  console.log(\`[oauth] unlinked "\${org}"\`);
  res.json({ unlinked: true });
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));`,
    'app.post("/unlink"',
  ],
  [
    "start the heartbeat",
    "// Should exceed nginx's own timeouts to avoid mid-request resets.",
    "startHeartbeat();\n\n// Should exceed nginx's own timeouts to avoid mid-request resets.",
    "startHeartbeat();",
  ],
];

// --- tools.js ---------------------------------------------------------------
let tools = fs.readFileSync("tools.js", "utf8");
const toolsUtilImport = tools.includes('import { ok, fail, mapLimit, envFlag } from "./util.js";')
  ? 'import { ok, fail, mapLimit, envFlag } from "./util.js";'
  : 'import { ok, fail, mapLimit } from "./util.js";';

const toolsSteps = [
  [
    "import the reporter",
    toolsUtilImport,
    `${toolsUtilImport}\nimport { reportEvent } from "./status-reporter.js";`,
    'from "./status-reporter.js";',
  ],
  [
    "add noteActivity()",
    "const READ_ONLY = { readOnlyHint: true, openWorldHint: false };",
    `// Tool activity worth telling the Connector Store about. Reads are deliberately
// absent: they are frequent and say nothing the heartbeat doesn't already say.
const EVENT_TEXT = {
  create_app: "App created in AJEMS",
  update_app: "App updated in AJEMS",
  create_form: "Form created in AJEMS",
  update_form: "Form settings changed in AJEMS",
  add_records: "Records written to AJEMS",
  update_record: "Record updated in AJEMS",
};

/** Best effort, never awaited, and silent for previews and failures. */
function noteActivity(ctx, name, args, result) {
  const text = EVENT_TEXT[name];
  if (!text) return;                  // a read tool
  if (args?.confirm !== true) return; // confirmation preview: nothing was written
  if (result?.isError) return;        // the write did not succeed

  const records = name === "add_records" ? (args.records?.length ?? 0)
    : name === "update_record" ? 1
    : 0;

  try {
    reportEvent(ctx, { kind: "ok", text, records });
  } catch {
    // Reporting must never affect a tool result.
  }
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };`,
    "function noteActivity(ctx, name, args, result) {",
  ],
  [
    "report after a successful tool call",
    `      try {
        return await handler(args);
      } catch (e) {
        return fail(e.message);
      }`,
    `      try {
        const result = await handler(args);
        noteActivity(ctx, name, args, result);
        return result;
      } catch (e) {
        return fail(e.message);
      }`,
    "noteActivity(ctx, name, args, result);",
  ],
];

function run(file, source, steps) {
  let out = source;
  for (const [label, anchor, replacement, marker] of steps) {
    if (out.includes(marker)) {
      edits.push(`  skip   ${file}: ${label} (already applied)`);
      continue;
    }
    if (!out.includes(anchor)) {
      edits.push(`  FAIL   ${file}: ${label} — anchor not found`);
      failed = true;
      continue;
    }
    out = out.replace(anchor, replacement);
    edits.push(`  patch  ${file}: ${label}`);
  }
  return out;
}

oauth = run("oauth.js", fs.readFileSync("oauth.js", "utf8"), oauthSteps);
server = run("server.js", fs.readFileSync("server.js", "utf8"), serverSteps);
tools = run("tools.js", fs.readFileSync("tools.js", "utf8"), toolsSteps);

console.log(edits.join("\n"));

if (failed) {
  console.error("\nOne or more anchors were not found. Nothing was written.");
  process.exit(1);
}
if (CHECK) {
  console.log("\n--check: nothing written.");
  process.exit(0);
}
if (!fs.existsSync("status-reporter.js")) {
  console.error("\nstatus-reporter.js is missing — copy it in first. Nothing was written.");
  process.exit(1);
}

for (const [file, content] of [["oauth.js", oauth], ["server.js", server], ["tools.js", tools]]) {
  if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, content);
}
console.log("\nDone. Originals saved as *.bak. Restart the server.");

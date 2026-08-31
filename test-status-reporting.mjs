// test-status-reporting.mjs — exercises status-reporter.js against a fake
// Connector Store on loopback. No AJEMS, no Claude, no network egress.
//
//   node test-status-reporting.mjs


import http from "node:http";

let received = [];
let mode = "ok";   // ok | 401 | 500 | hang

const store = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url, body: JSON.parse(body || "{}") });
    if (mode === "hang") return;
    if (mode === "401") return res.writeHead(401).end('{"error":"bad key"}');
    if (mode === "500") return res.writeHead(500).end("boom");
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  });
});
await new Promise((r) => store.listen(0, "127.0.0.1", r));
const PORT = store.address().port;

process.env.CONNECTOR_STORE_REPORT_URL = `http://127.0.0.1:${PORT}/api/connectors/{ai}/report`;
process.env.STATUS_HEARTBEAT_MS = "300";
process.env.STATUS_EVENT_THROTTLE_MS = "500";
process.env.STATUS_REPORT_TIMEOUT_MS = "600";

const R = await import("./status-reporter.js");

const logLines = [];
for (const level of ["log", "warn", "error"]) {
  const original = console[level];
  console[level] = (...a) => { logLines.push(a.join(" ")); original(...a); };
}

const SECRET = "sk-super-secret-key-9f2a";
const claudeCtx = { tenant: "kathaa", secretKey: SECRET, user: "kathaa", client: "claude" };
const gptCtx = { tenant: "kathaa", secretKey: SECRET, user: "ops@kathaa.com", client: "chatgpt" };
const geminiCtx = { tenant: "acme", secretKey: "sk-acme-77", user: "acme", client: "gemini" };

let passed = 0, failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const reset = () => { received = []; };

console.log("=".repeat(64));

// 1 --------------------------------------------------------------------------
console.log("\n1. Identifies the AI from OAuth redirect URIs");
const cases = [
  ["https://claude.ai/api/mcp/auth_callback", "claude"],
  ["https://claude.com/api/mcp/auth_callback", "claude"],
  ["https://console.anthropic.com/oauth/cb", "claude"],
  ["https://chatgpt.com/connector_platform_oauth_redirect", "chatgpt"],
  ["https://chat.openai.com/aip/cb", "chatgpt"],
  ["https://gemini.google.com/oauth/cb", "gemini"],
  ["https://example.com/cb", null],
];
for (const [uri, expected] of cases) {
  check(`${uri.slice(0, 46).padEnd(46)} -> ${expected}`, R.identifyClient({ redirectUri: uri }) === expected);
}

// 2 --------------------------------------------------------------------------
console.log("\n2. Identifies the AI from the MCP handshake and client name");
check("clientInfo 'claude-ai'", R.identifyClient({ mcpClientName: "claude-ai" }) === "claude");
check("clientInfo 'ChatGPT'", R.identifyClient({ mcpClientName: "ChatGPT" }) === "chatgpt");
check("clientInfo 'Gemini CLI'", R.identifyClient({ mcpClientName: "Gemini CLI" }) === "gemini");
check("registered name 'Claude Desktop'", R.identifyClient({ clientName: "Claude Desktop" }) === "claude");
check("user-agent fallback", R.identifyClient({ userAgent: "openai-mcp/1.0" }) === "chatgpt");
check("nothing recognisable -> null", R.identifyClient({ clientName: "curl" }) === null);
check("no signals at all -> null", R.identifyClient() === null);
check("redirect URI beats a misleading name",
  R.identifyClient({ redirectUri: "https://claude.ai/cb", clientName: "ChatGPT" }) === "claude");

// 3 --------------------------------------------------------------------------
console.log("\n3. Each AI is reported to its own endpoint");
reset();
R.reportConnected(claudeCtx);
R.reportConnected(gptCtx);
R.reportConnected(geminiCtx);
await settle();
{
  const paths = received.map((r) => r.url);
  check("claude -> /api/connectors/claude/report", paths.includes("/api/connectors/claude/report"));
  check("chatgpt -> /api/connectors/chatgpt/report", paths.includes("/api/connectors/chatgpt/report"));
  check("gemini -> /api/connectors/gemini/report", paths.includes("/api/connectors/gemini/report"));
  check("three separate reports", received.length === 3, `got ${received.length}`);
  const c = received.find((r) => r.url.includes("/claude/"))?.body;
  check("status is connected", c?.status === "connected");
  check("org reused from the session", c?.org === "kathaa");
  check("secretKey reused from the session", c?.secretKey === SECRET);
  check("event names the AI", c?.event?.text === "Claude MCP connected");
  check("records present", c?.records === 0);
  check("no instance field", !("instance" in (c || {})));
  check("no ai field in the body (it is the path)", !("ai" in (c || {})));
  check("secretKey never in the URL", received.every((r) => !r.url.includes(SECRET)));
  const g = received.find((r) => r.url.includes("/chatgpt/"))?.body;
  check("connectedBy sent when it is an email", g?.connectedBy === "ops@kathaa.com");
  check("connectedBy omitted otherwise", !("connectedBy" in (c || {})));
}

// 4 --------------------------------------------------------------------------
console.log("\n4. Same org on two AIs is two independent connections");
check("registry holds both", R.linkedCount() === 3, `got ${R.linkedCount()}`);
reset();
R.startHeartbeat();
await settle(800);
{
  const seen = new Set(received.map((r) => `${r.url}|${r.body.org}`));
  check("kathaa heart-beaten on claude", [...seen].some((s) => s.includes("/claude/") && s.endsWith("kathaa")));
  check("kathaa heart-beaten on chatgpt", [...seen].some((s) => s.includes("/chatgpt/") && s.endsWith("kathaa")));
  check("acme heart-beaten on gemini", [...seen].some((s) => s.includes("/gemini/") && s.endsWith("acme")));
  check("heartbeat carries no event", received.every((r) => !r.body.event));
}
R.stopHeartbeat();

// 5 --------------------------------------------------------------------------
console.log("\n5. Unidentified clients are held back, not guessed");
reset();
R.reportConnected({ tenant: "mystery", secretKey: "sk-x", user: "mystery", client: null });
await settle();
check("nothing sent for an unknown AI", received.length === 0, `got ${received.length}`);
check("warned about it", logLines.some((l) => l.includes("mystery") && l.includes("could not be identified")));

// 6 --------------------------------------------------------------------------
console.log("\n6. Tool events are throttled per AI per organisation");
reset();
for (let i = 0; i < 25; i++) R.reportEvent(claudeCtx, { kind: "ok", text: "Records written to AJEMS", records: 3 });
await settle();
check("25 rapid events collapse to 1", received.length === 1, `got ${received.length}`);
check("records forwarded", received[0]?.body.records === 3);
check("routed to the claude endpoint", received[0]?.url.includes("/claude/"));
reset();
R.reportEvent(gptCtx, { kind: "ok", text: "Form created in AJEMS" });
await settle();
check("the other AI is throttled separately", received.length === 1 && received[0].url.includes("/chatgpt/"));

// 7 --------------------------------------------------------------------------
console.log("\n7. Unlinking reports disconnected for that AI only");
reset();
R.reportDisconnected("kathaa", "claude");
await settle();
check("one disconnect sent", received.length === 1, `got ${received.length}`);
check("status is disconnected", received[0]?.body.status === "disconnected");
check("on the claude endpoint", received[0]?.url.includes("/claude/"));
reset();
R.startHeartbeat();
await settle(400);
check("claude/kathaa no longer heart-beaten", !received.some((r) => r.url.includes("/claude/") && r.body.org === "kathaa"));
check("chatgpt/kathaa still heart-beaten", received.some((r) => r.url.includes("/chatgpt/") && r.body.org === "kathaa"));
R.stopHeartbeat();

// 8 --------------------------------------------------------------------------
console.log("\n8. Store failures never throw");
for (const m of ["401", "500", "hang"]) {
  mode = m;
  reset();
  let threw = false;
  try {
    R.reportConnected(claudeCtx);
    R.reportEvent(claudeCtx, { kind: "ok", text: "App created in AJEMS" });
    await settle(m === "hang" ? 900 : 250);
  } catch { threw = true; }
  check(`store returning ${m} does not throw`, !threw);
}
mode = "ok";

// 9 --------------------------------------------------------------------------
console.log("\n9. Store unreachable never throws");
await new Promise((r) => store.close(r));
reset();
let threw = false;
try { R.reportConnected(claudeCtx); await settle(400); } catch { threw = true; }
check("connection refused does not throw", !threw);

// 10 -------------------------------------------------------------------------
console.log("\n10. No secret material reaches the logs");
const joined = logLines.join("\n");
check("secret key never logged", !joined.includes(SECRET));
check("second secret never logged", !joined.includes("sk-acme-77"));

// 11 -------------------------------------------------------------------------
console.log("\n11. A non-HTTPS remote endpoint is refused");
{
  process.env.CONNECTOR_STORE_REPORT_URL = "http://evil.example/api/connectors/{ai}/report";
  const fresh = await import(`./status-reporter.js?http=${Date.now()}`);
  fresh.reportConnected(claudeCtx);
  await settle(150);
  check("plain http to a remote host is disabled", fresh.linkedCount() === 0);
}

// 12 -------------------------------------------------------------------------
// Old sessions carry no `client`. With STATUS_ASSUME_CLIENT they still report,
// and the assumption is corrected the moment the handshake identifies them.
console.log("\n12. STATUS_ASSUME_CLIENT covers sessions predating detection");
{
  const store2 = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise((r) => store2.listen(0, "127.0.0.1", r));
  const p2 = store2.address().port;

  process.env.CONNECTOR_STORE_REPORT_URL = `http://127.0.0.1:${p2}/api/connectors/{ai}/report`;
  process.env.STATUS_ASSUME_CLIENT = "claude";
  const A = await import(`./status-reporter.js?assume=${Date.now()}`);

  // A session restored from sessions.json: tenant and key, but no client.
  const legacy = { tenant: "oldorg", secretKey: "sk-old-1", user: "oldorg" };

  reset();
  A.reportConnected(legacy);
  await settle();
  check("legacy session is reported", received.length === 1, `got ${received.length}`);
  check("routed to the assumed AI", received[0]?.url.includes("/claude/"));
  check("marked assumed in the summary", A.linkedSummary().some((e) => e.org === "oldorg" && e.assumed === true));

  reset();
  await A.startHeartbeat?.();
  check("assumption is not persisted onto the session", legacy.client === undefined);

  // Handshake says it is really ChatGPT.
  reset();
  const dropped = A.dropAssumedExcept("oldorg", "chatgpt");
  A.reportConnected({ ...legacy, client: "chatgpt" });
  await settle();
  check("the wrong assumed entry was retired", dropped === 1);
  check("a disconnect went to claude", received.some((r) => r.url.includes("/claude/") && r.body.status === "disconnected"));
  check("a connect went to chatgpt", received.some((r) => r.url.includes("/chatgpt/") && r.body.status === "connected"));
  check("only chatgpt remains for that org",
    A.linkedSummary().filter((e) => e.org === "oldorg").every((e) => e.ai === "chatgpt"));

  // The common case: assumption was right. Must not flap.
  reset();
  A.reportConnected({ tenant: "rightorg", secretKey: "sk-r" });
  await settle();
  const droppedRight = A.dropAssumedExcept("rightorg", "claude");
  A.reportConnected({ tenant: "rightorg", secretKey: "sk-r", client: "claude" });
  await settle();
  check("a correct assumption is not retired", droppedRight === 0);
  check("no disconnect was sent for it", !received.some((r) => r.body.status === "disconnected"));
  check("it is no longer marked assumed",
    A.linkedSummary().some((e) => e.org === "rightorg" && !e.assumed));

  A.stopHeartbeat();
  await new Promise((r) => store2.close(r));
}

console.log("\n" + "=".repeat(64));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

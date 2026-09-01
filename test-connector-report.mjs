// test-connector-report.mjs — runs the reporting block extracted from the
// PATCHED server.js against a fake Connector Store on loopback.
//
// It reads the real file, so it tests the code you are actually shipping.
//
//   node test-connector-report.mjs

import http from "node:http";
import fs from "node:fs";

const source = fs.readFileSync("server.js", "utf8");
const startMarker = source.indexOf("[connector-report:start]");
const end = source.indexOf("// [connector-report:end]");
if (startMarker < 0 || end < 0) {
  console.error("Could not find the connector-report block in server.js. Run the patcher first.");
  process.exit(1);
}
// Begin at the line AFTER the marker so the marker text itself is not parsed as code.
const start = source.indexOf("\n", startMarker) + 1;

let received = [];
let mode = "ok";

const store = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url, body: JSON.parse(body || "{}") });
    if (mode === "hang") return;
    if (mode !== "ok") return res.writeHead(Number(mode)).end("nope");
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  });
});
await new Promise((r) => store.listen(0, "127.0.0.1", r));
const PORT = store.address().port;

process.env.CONNECTOR_STORE_URL = `http://127.0.0.1:${PORT}/api/connectors`;
process.env.CONNECTOR_HEARTBEAT_MS = "400";
process.env.CONNECTOR_REPORT_TIMEOUT_MS = "600";
process.env.CONNECTOR_ACTIVE_WINDOW_MS = "60000";

// Load the block as a module by appending exports for the functions it defines.
const block = source.slice(start, end);
const tmp = "./.connector-block.test.mjs";
fs.writeFileSync(tmp, `${block}
export { reportToStore, reportOrg, reportClient, linkOrg, seedLinkedOrgs, noteClient, disconnectOrg,
         targetsFor, detectClient, orgClientSet, startConnectorHeartbeat, linkedOrgs, orgClients, STORE_ENDPOINTS };
`);
const M = await import(tmp);

const logLines = [];
const originalLog = console.log;
console.log = (...a) => { logLines.push(a.join(" ")); originalLog(...a); };

let passed = 0, failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const reset = () => { received = []; };

const KEY_A = "sk-tenant-a-secret-2f91";
const KEY_B = "sk-tenant-b-secret-77c3";

console.log("=".repeat(64));

// 1 --------------------------------------------------------------------------
console.log("\n1. Strict isolation: an unidentified org is reported NOWHERE");
reset();
M.linkOrg("orgone", KEY_A);
check("no targets while unidentified", M.targetsFor("orgone").length === 0);
M.reportOrg("orgone");
await settle();
check("zero reports sent", received.length === 0, `got ${received.length}`);

// 2 --------------------------------------------------------------------------
console.log("\n2. An identified client reports to its ONE endpoint only");
reset();
M.reportClient("orgone", "claude");
await settle();
{
  check("exactly one report sent", received.length === 1, `got ${received.length}`);
  check("claude endpoint hit", received[0]?.url === "/api/connectors/claude/report");
  const b = received[0]?.body || {};
  check("body has org", b.org === "orgone");
  check("body has secretKey", b.secretKey === KEY_A);
  check("body has status connected", b.status === "connected");
  check("secretKey never in the URL", received.every((r) => !r.url.includes(KEY_A)));
  check("unknown client name is a no-op", (M.reportClient("orgone", "gemini"), true));
  const lines = logLines.filter((l) => l.startsWith("[connector-report]"));
  check("logs endpoint, org and status", lines.some((l) => /^\[connector-report\] claude org=orgone status=200$/.test(l)));
  check("no secret in any log line", !logLines.join("\n").includes(KEY_A));
}

// 3 --------------------------------------------------------------------------
console.log("\n3. Client identification from OAuth hints and handshake names");
check("claude.ai redirect detected", M.detectClient("https://claude.ai/api/mcp/auth_callback") === "claude");
check("chatgpt.com redirect detected", M.detectClient("https://chatgpt.com/connector_platform_oauth_redirect ChatGPT") === "chatgpt");
check("clientInfo name detected", M.detectClient("Claude Desktop") === "claude");
check("unrecognised name is null", M.detectClient("curl/8.0") === null);
check("empty is null", M.detectClient("") === null);
{
  const noted = M.noteClient("orgone", "claude-ai");
  check("noteClient adds the client", noted === "claude");
  check("re-noting the same client is a no-op", M.noteClient("orgone", "Claude Desktop") === null);
  check("orgone now targets claude only", M.targetsFor("orgone").join() === "claude");
  M.noteClient("orgone", "ChatGPT");
  check("an org can hold both clients at once", M.targetsFor("orgone").sort().join() === "chatgpt,claude".split(",").sort().join());
  M.orgClients.set("orgone", new Set(["claude"]));   // back to claude-only for later tests
}

// 4 --------------------------------------------------------------------------
console.log("\n4. Saved sessions seed linkedOrgs with their client at startup");
reset();
const saved = [
  { tenant: "seeded1", secretKey: KEY_B, user: "seeded1" },              // no client recorded
  { tenant: "seeded2", secretKey: "sk-two", client: "chatgpt" },         // client known
  { tenant: "seeded2", secretKey: "sk-two", client: "chatgpt" },         // duplicate, same org+client
  { tenant: "broken" },                                                   // no key: must be skipped
];
const count = M.seedLinkedOrgs(saved);
check("orgs de-duplicated", count === 3, `got ${count}`);
check("keyless session skipped", !M.linkedOrgs.has("broken"));
check("clientless org has no targets", M.targetsFor("seeded1").length === 0);
check("seeded2 targets chatgpt only", M.targetsFor("seeded2").join() === "chatgpt");

// 5 --------------------------------------------------------------------------
console.log("\n5. Heartbeat covers active identified sessions only");
reset();
const now = Date.now();
const activeSessions = [
  { tenant: "orgone", secretKey: KEY_A, client: "claude", lastSeen: now },
  { tenant: "orgone", secretKey: KEY_A, client: "claude", lastSeen: now },   // duplicate (client, org)
  { tenant: "seeded1", secretKey: KEY_B, lastSeen: now },                     // unidentified: never reported
  { tenant: "seeded2", secretKey: "sk-two", client: "chatgpt", lastSeen: now },
  { tenant: "zombie", secretKey: "sk-zombie", client: "claude", lastSeen: now - 120000 },   // dormant
];
M.startConnectorHeartbeat(() => activeSessions);
await settle(950);
{
  const orgs = new Set(received.map((r) => r.body.org));
  check("identified orgs heart-beaten", orgs.has("orgone") && orgs.has("seeded2"), `got ${[...orgs]}`);
  check("unidentified session never reported", !orgs.has("seeded1"));
  check("one report per (client, org) per beat", received.filter((r) => r.body.org === "orgone").length <= 3);
  check("repeats on the interval", received.length >= 4, `got ${received.length} in ~950ms at 400ms`);
  check("all report connected", received.every((r) => r.body.status === "connected"));
  check("no heartbeat carries reconnect", received.every((r) => !("reconnect" in r.body)));
  check("claude session only hits claude", received.filter((r) => r.body.org === "orgone").every((r) => r.url.includes("/claude/")));
  check("chatgpt session only hits chatgpt", received.filter((r) => r.body.org === "seeded2").every((r) => r.url.includes("/chatgpt/")));
  check("dormant session never heartbeated", !orgs.has("zombie"));
}

// 6 --------------------------------------------------------------------------
console.log("\n6. Disconnect is per client, and only when its last session goes");
M.orgClients.set("seeded1", new Set(["claude", "chatgpt"]));
reset();
const stillActive = [
  { tenant: "seeded1", secretKey: KEY_B, client: "claude", lastSeen: Date.now() },
  { tenant: "seeded1", secretKey: KEY_B, client: "chatgpt", lastSeen: Date.now() },
];
// The heartbeat interval from test 5 is still beating in the background, so
// these checks look only at disconnect reports, never at total traffic.
const disconnects = () => received.filter((r) => r.body.status === "disconnected");

check("kept while same-client session exists", M.disconnectOrg("seeded1", "claude", stillActive) === false);
await settle(50);
check("no disconnect was sent", disconnects().length === 0);

reset();
// A dormant same-client sibling (an unrevoked zombie) must NOT block the report.
const zombieSibling = [
  { tenant: "seeded1", secretKey: KEY_B, client: "claude", lastSeen: Date.now() - 120000 },
];
M.disconnectOrg("seeded1", "claude", zombieSibling);
await settle();
check("zombie sibling does not block disconnect", disconnects().length === 1 && disconnects()[0].url.includes("/claude/"));
M.orgClientSet("seeded1").add("claude");   // restore for the next checks

reset();
const onlyChatgptLeft = [{ tenant: "seeded1", secretKey: KEY_B, client: "chatgpt", lastSeen: Date.now() }];
check("org kept while another client remains", M.disconnectOrg("seeded1", "claude", onlyChatgptLeft) === false);
await settle();
check("claude got its disconnect", disconnects().length === 1 && disconnects()[0].url.includes("/claude/"));
check("claude removed from targets", M.targetsFor("seeded1").join() === "chatgpt");
check("org still in linkedOrgs", M.linkedOrgs.has("seeded1"));

reset();
check("org dropped when no session remains", M.disconnectOrg("seeded1", "chatgpt", []) === true);
await settle();
check("chatgpt disconnect sent to chatgpt only", disconnects().length === 1 && disconnects()[0].url.includes("/chatgpt/"));
check("disconnect body carries org and key", disconnects()[0]?.body.org === "seeded1" && disconnects()[0]?.body.secretKey === KEY_B);
check("dropped from linkedOrgs", !M.linkedOrgs.has("seeded1"));

reset();
M.linkOrg("ghost", "sk-ghost");
check("unidentified session disconnect reports nothing", (M.disconnectOrg("ghost", null, []), disconnects().length === 0));
check("unknown org is a no-op", M.disconnectOrg("nosuchorg", "claude", []) === false);
await settle(50);
check("still nothing sent", disconnects().length === 0);

// 7 --------------------------------------------------------------------------
console.log("\n7. Store failures never throw");
for (const m of ["400", "401", "404", "500", "hang"]) {
  mode = m;
  reset();
  let threw = false;
  try {
    M.reportOrg("orgone");   // orgone targets claude
    await settle(m === "hang" ? 900 : 200);
  } catch { threw = true; }
  check(`store ${m} does not throw`, !threw);
}
check("timeout logged without a secret", logLines.some((l) => l.includes("status=failed (timeout)")));
mode = "ok";

// 8 --------------------------------------------------------------------------
console.log("\n8. Store unreachable never throws");
// close() alone would wait forever: the heartbeat keeps a keep-alive socket
// busy. Force every connection shut so new requests are refused immediately.
store.close();
store.closeAllConnections();
await settle(100);
reset();
let threw = false;
try { M.reportOrg("orgone"); await settle(400); } catch { threw = true; }
check("connection refused does not throw", !threw);
check("no secret leaked across every log line", !logLines.join("\n").match(/sk-tenant|sk-two|sk-ghost/));

fs.unlinkSync(tmp);
console.log("\n" + "=".repeat(64));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

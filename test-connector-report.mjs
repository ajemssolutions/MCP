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

// Load the block as a module by appending exports for the functions it defines.
const block = source.slice(start, end);
const tmp = "./.connector-block.test.mjs";
fs.writeFileSync(tmp, `${block}
export { reportToStore, reportOrg, linkOrg, seedLinkedOrgs, noteClient, disconnectOrg,
         targetsFor, detectClient, startConnectorHeartbeat, linkedOrgs, orgClients, STORE_ENDPOINTS };
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
console.log("\n1. An unidentified org is reported to BOTH endpoints");
reset();
M.linkOrg("orgone", KEY_A);
M.reportOrg("orgone");
await settle();
{
  const paths = received.map((r) => r.url).sort();
  check("two reports sent", received.length === 2, `got ${received.length}`);
  check("claude endpoint hit", paths.includes("/api/connectors/claude/report"));
  check("chatgpt endpoint hit", paths.includes("/api/connectors/chatgpt/report"));
  const b = received[0].body;
  check("body has org", b.org === "orgone");
  check("body has secretKey", b.secretKey === KEY_A);
  check("body has status connected", b.status === "connected");
  check("secretKey never in the URL", received.every((r) => !r.url.includes(KEY_A)));
}

// 2 --------------------------------------------------------------------------
console.log("\n2. Log format is safe and matches the spec");
{
  const lines = logLines.filter((l) => l.startsWith("[connector-report]"));
  check("logs endpoint, org and status", lines.some((l) => /^\[connector-report\] (claude|chatgpt) org=orgone status=200$/.test(l)));
  check("no secret in any log line", !logLines.join("\n").includes(KEY_A));
}

// 3 --------------------------------------------------------------------------
console.log("\n3. The handshake narrows an org to one endpoint");
reset();
check("both endpoints before identification", M.targetsFor("orgone").length === 2);
const noted = M.noteClient("orgone", "claude-ai");
check("client identified", noted === "claude");
M.reportOrg("orgone");
await settle();
check("now only claude is reported", received.length === 1 && received[0].url.includes("/claude/"));
check("re-identifying the same client is a no-op", M.noteClient("orgone", "Claude Desktop") === null);
check("an unrecognised name changes nothing", M.noteClient("orgone", "curl/8.0") === null);
check("chatgpt is detected too", M.detectClient("ChatGPT") === "chatgpt");

// 4 --------------------------------------------------------------------------
console.log("\n4. Saved sessions seed linkedOrgs at startup");
reset();
const saved = [
  { tenant: "seeded1", secretKey: KEY_B, user: "seeded1" },              // no client recorded
  { tenant: "seeded1", secretKey: KEY_B, user: "seeded1" },              // duplicate token, same org
  { tenant: "seeded2", secretKey: "sk-two", client: "chatgpt" },         // client known
  { tenant: "broken" },                                                   // no key: must be skipped
];
const count = M.seedLinkedOrgs(saved);
check("orgs de-duplicated", count === 3, `got ${count}`);
check("keyless session skipped", !M.linkedOrgs.has("broken"));
check("seeded1 reports to both", M.targetsFor("seeded1").length === 2);
check("seeded2 reports to chatgpt only", M.targetsFor("seeded2").join() === "chatgpt");

// 5 --------------------------------------------------------------------------
console.log("\n5. Heartbeat covers every linked org");
reset();
M.startConnectorHeartbeat();
await settle(950);
{
  const orgs = new Set(received.map((r) => r.body.org));
  check("every org heart-beaten", ["orgone", "seeded1", "seeded2"].every((o) => orgs.has(o)), `got ${[...orgs]}`);
  check("repeats on the interval", received.length >= 8, `got ${received.length} in ~950ms at 400ms`);
  check("all report connected", received.every((r) => r.body.status === "connected"));
  check("seeded1 still goes to both", received.filter((r) => r.body.org === "seeded1").some((r) => r.url.includes("/chatgpt/")));
}

// 6 --------------------------------------------------------------------------
console.log("\n6. Disconnect only when no session remains");
reset();
const stillActive = [{ tenant: "seeded1", secretKey: KEY_B }];
check("kept while another session exists", M.disconnectOrg("seeded1", stillActive) === false);
check("still in linkedOrgs", M.linkedOrgs.has("seeded1"));
await settle(50);
check("no disconnect was sent", !received.some((r) => r.body.status === "disconnected"));

reset();
check("removed when none remain", M.disconnectOrg("seeded1", []) === true);
await settle();
check("disconnected reported", received.some((r) => r.body.status === "disconnected" && r.body.org === "seeded1"));
check("dropped from linkedOrgs", !M.linkedOrgs.has("seeded1"));
check("disconnect body carries the key", received[0]?.body.secretKey === KEY_B);
check("unknown org is a no-op", M.disconnectOrg("nosuchorg", []) === false);

// 7 --------------------------------------------------------------------------
console.log("\n7. Store failures never throw");
for (const m of ["400", "401", "404", "500", "hang"]) {
  mode = m;
  reset();
  let threw = false;
  try {
    M.reportOrg("orgone");
    await settle(m === "hang" ? 900 : 200);
  } catch { threw = true; }
  check(`store ${m} does not throw`, !threw);
}
check("timeout logged without a secret", logLines.some((l) => l.includes("status=failed (timeout)")));
mode = "ok";

// 8 --------------------------------------------------------------------------
console.log("\n8. Store unreachable never throws");
await new Promise((r) => store.close(r));
reset();
let threw = false;
try { M.reportOrg("orgone"); await settle(400); } catch { threw = true; }
check("connection refused does not throw", !threw);
check("no secret leaked across every log line", !logLines.join("\n").match(/sk-tenant|sk-two/));

fs.unlinkSync(tmp);
console.log("\n" + "=".repeat(64));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

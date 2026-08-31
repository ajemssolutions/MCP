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
    if (mode === "hang") return;                       // never responds
    if (mode === "401") return res.writeHead(401).end('{"error":"bad key"}');
    if (mode === "500") return res.writeHead(500).end("boom");
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  });
});
await new Promise((r) => store.listen(0, "127.0.0.1", r));
const PORT = store.address().port;

process.env.CONNECTOR_STORE_REPORT_URL = `http://127.0.0.1:${PORT}/api/connectors/claude/report`;
process.env.STATUS_HEARTBEAT_MS = "300";
process.env.STATUS_EVENT_THROTTLE_MS = "500";
process.env.STATUS_REPORT_TIMEOUT_MS = "600";

const R = await import("./status-reporter.js");

// Capture logs so we can prove no secret is ever written to them.
const logLines = [];
for (const level of ["log", "warn", "error"]) {
  const original = console[level];
  console[level] = (...a) => { logLines.push(a.join(" ")); original(...a); };
}

const SECRET = "sk-super-secret-key-9f2a";
const ctxA = { tenant: "kathaa", baseUrl: "https://kathaa.example/json_builder", secretKey: SECRET, user: "kathaa" };
const ctxB = { tenant: "acme", baseUrl: "https://acme.example/json_builder", secretKey: "sk-acme-77", user: "ops@acme.com" };

let passed = 0, failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const reset = () => { received = []; };

console.log("=".repeat(64));

// 1 --------------------------------------------------------------------------
console.log("\n1. Reports connected when a workspace is linked");
reset();
R.reportConnected(ctxA);
await settle();
{
  const r = received[0];
  check("one report sent", received.length === 1);
  check("status is connected", r?.body.status === "connected");
  check("org reused from the session", r?.body.org === "kathaa");
  check("secretKey reused from the session", r?.body.secretKey === SECRET);
  check("event shape matches the spec", r?.body.event?.kind === "ok" && r?.body.event?.text === "Claude MCP connected");
  check("records present", r?.body.records === 0);
  check("no instance field", !("instance" in (r?.body || {})));
  check("connectedBy omitted when it is not an email", !("connectedBy" in (r?.body || {})));
  check("secretKey not in the URL", !r?.url.includes(SECRET));
}

// 2 --------------------------------------------------------------------------
console.log("\n2. connectedBy is sent when the session carries an email");
reset();
R.reportConnected(ctxB);
await settle();
check("connectedBy forwarded", received[0]?.body.connectedBy === "ops@acme.com");

// 3 --------------------------------------------------------------------------
console.log("\n3. Heartbeat covers every linked organisation");
reset();
R.startHeartbeat();
await settle(800);
{
  const orgs = new Set(received.map((r) => r.body.org));
  check("both orgs heart-beaten", orgs.has("kathaa") && orgs.has("acme"), `got ${[...orgs]}`);
  check("heartbeat repeats", received.length >= 4, `got ${received.length} in 800ms at 300ms interval`);
  check("heartbeat carries no event", received.every((r) => !r.body.event));
  check("heartbeat status is connected", received.every((r) => r.body.status === "connected"));
}

// 4 --------------------------------------------------------------------------
console.log("\n4. Tool events are throttled per organisation");
R.stopHeartbeat();
reset();
for (let i = 0; i < 25; i++) R.reportEvent(ctxA, { kind: "ok", text: "Records written to AJEMS", records: 3 });
await settle();
check("25 rapid events collapse to 1", received.length === 1, `got ${received.length}`);
check("records forwarded", received[0]?.body.records === 3);
await settle(600);
R.reportEvent(ctxA, { kind: "ok", text: "Records written to AJEMS", records: 1 });
await settle();
check("a later event passes once the window expires", received.length === 2, `got ${received.length}`);

// 5 --------------------------------------------------------------------------
console.log("\n5. Unlinking reports disconnected");
reset();
const before = R.linkedCount();
R.reportDisconnected("kathaa");
await settle();
check("disconnected sent", received[0]?.body.status === "disconnected");
check("org still identified", received[0]?.body.org === "kathaa");
check("dropped from the registry", R.linkedCount() === before - 1);
reset();
R.startHeartbeat();
await settle(400);
check("no further heartbeat for the unlinked org", !received.some((r) => r.body.org === "kathaa"));
R.stopHeartbeat();

// 6 --------------------------------------------------------------------------
console.log("\n6. Store failures never throw");
for (const m of ["401", "500", "hang"]) {
  mode = m;
  reset();
  let threw = false;
  try {
    R.reportConnected(ctxA);
    R.reportEvent(ctxA, { kind: "ok", text: "App created in AJEMS" });
    await settle(m === "hang" ? 900 : 250);
  } catch { threw = true; }
  check(`store returning ${m} does not throw`, !threw);
}
mode = "ok";

// 7 --------------------------------------------------------------------------
console.log("\n7. Store being completely unreachable never throws");
await new Promise((r) => store.close(r));
reset();
let threw = false;
try {
  R.reportConnected(ctxA);
  await settle(400);
} catch { threw = true; }
check("connection refused does not throw", !threw);

// 8 --------------------------------------------------------------------------
console.log("\n8. No secret material reaches the logs");
const joined = logLines.join("\n");
check("secret key never logged", !joined.includes(SECRET));
check("second secret never logged", !joined.includes("sk-acme-77"));

// 9 --------------------------------------------------------------------------
console.log("\n9. A non-HTTPS endpoint is refused");
{
  const probe = await import(`./status-reporter.js?nocache=${Date.now()}`);
  process.env.CONNECTOR_STORE_REPORT_URL = "http://evil.example/report";
  const fresh = await import(`./status-reporter.js?http=${Date.now()}`);
  fresh.reportConnected(ctxA);
  await settle(150);
  check("plain http to a remote host is disabled", fresh.linkedCount() === 0);
  void probe;
}

console.log("\n" + "=".repeat(64));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

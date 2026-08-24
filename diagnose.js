// diagnose.js — replays exactly what Claude does, against your public URL.
//
//   node diagnose.js https://mcp.ajems.in <organisation> <secret-key>
//
// If every step passes here, your server is fine and the problem is on the
// Claude side (usually a stale connector — delete and re-add it).
// If a step fails, the output tells you which one and why.

const BASE = (process.argv[2] || "").replace(/\/$/, "");
const ORG = process.argv[3];
const KEY = process.argv[4];

if (!BASE || !ORG || !KEY) {
  console.error("Usage: node diagnose.js <public-url> <organisation> <secret-key>");
  process.exit(1);
}

let step = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
const head = (m) => console.log(`\n${++step}. ${m}`);

const get = async (path) => {
  const res = await fetch(BASE + path, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
};

console.log(`Testing ${BASE}\n${"=".repeat(60)}`);

// 1 --------------------------------------------------------------------------
head("Is the server reachable?");
{
  const r = await get("/health");
  if (r.status === 200 && r.json?.ok) pass(`/health -> ${JSON.stringify(r.json)}`);
  else fail(`/health returned ${r.status}: ${r.text.slice(0, 120)}`);
}

// 2 --------------------------------------------------------------------------
head("Does an unauthenticated MCP call challenge correctly?");
{
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const wa = res.headers.get("www-authenticate");
  if (res.status !== 401) fail(`expected 401, got ${res.status}`);
  else if (!wa?.includes("resource_metadata")) fail(`401 but WWW-Authenticate lacks resource_metadata: ${wa}`);
  else pass("401 with resource_metadata pointer");
}

// 3 --------------------------------------------------------------------------
head("Protected-resource metadata");
let resourceUrl = null;
{
  const r = await get("/.well-known/oauth-protected-resource/mcp");
  if (r.status !== 200 || !r.json) fail(`returned ${r.status}: ${r.text.slice(0, 120)}`);
  else {
    resourceUrl = r.json.resource;
    const expected = `${BASE}/mcp`;
    if (resourceUrl !== expected) fail(`resource is "${resourceUrl}" but should be "${expected}" — Claude will call the wrong address`);
    else pass(`resource -> ${resourceUrl}`);
  }
}

// 4 --------------------------------------------------------------------------
head("Authorization-server metadata");
let endpoints = null;
{
  const r = await get("/.well-known/oauth-authorization-server");
  if (r.status !== 200 || !r.json) fail(`returned ${r.status}: ${r.text.slice(0, 120)}`);
  else {
    endpoints = r.json;
    if (!endpoints.issuer?.startsWith(BASE)) fail(`issuer is "${endpoints.issuer}" but should be "${BASE}"`);
    else pass(`issuer -> ${endpoints.issuer}`);
    for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      if (!endpoints[k]) fail(`missing ${k}`);
    }
  }
}

// 5 --------------------------------------------------------------------------
head("Client registration");
let clientId = null;
if (endpoints?.registration_endpoint) {
  const res = await fetch(endpoints.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "diagnose.js",
    }),
  });
  const body = await res.json().catch(() => null);
  clientId = body?.client_id;
  if (!clientId) fail(`no client_id returned (status ${res.status})`);
  else pass(`client_id -> ${clientId}`);
}

// 6 --------------------------------------------------------------------------
head("Sign-in page renders");
{
  const url = `${endpoints?.authorization_endpoint}?client_id=${clientId}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&state=test123&response_type=code`;
  const res = await fetch(url);
  const html = await res.text();
  if (res.status !== 200) fail(`status ${res.status}`);
  else if (!html.includes("organisation") || !html.includes("secret_key")) fail("page loaded but is missing the sign-in fields");
  else pass("sign-in page OK");
}

// 7 --------------------------------------------------------------------------
head("Authorize with your token");
let code = null;
{
  const res = await fetch(`${BASE}/authorize/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      state: "test123",
      organisation: ORG,
      secret_key: KEY,
    }),
    redirect: "manual",
  });
  const loc = res.headers.get("location");
  if (res.status === 401) fail(`sign-in rejected for org "${ORG}" — check the organisation name and secret key`);
  else if (!loc) fail(`no redirect (status ${res.status})`);
  else {
    code = new URL(loc).searchParams.get("code");
    if (!code) fail(`redirect had no code: ${loc}`);
    else pass(`got authorization code`);
  }
}

// 8 --------------------------------------------------------------------------
head("Exchange code for access token");
let accessToken = null;
if (code) {
  const res = await fetch(endpoints.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      client_id: clientId || "",
    }),
  });
  const body = await res.json().catch(() => null);
  accessToken = body?.access_token;
  if (!accessToken) fail(`no access_token (status ${res.status}): ${JSON.stringify(body)}`);
  else pass("got access token");
}

// 9 --------------------------------------------------------------------------
head("MCP initialize with that token");
if (accessToken) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "diagnose", version: "1" } },
    }),
  });
  const text = await res.text();
  if (res.status !== 200) fail(`status ${res.status}: ${text.slice(0, 200)}`);
  else if (!text.includes("serverInfo")) fail(`unexpected body: ${text.slice(0, 200)}`);
  else pass("initialize OK");
}

// 10 -------------------------------------------------------------------------
head("List tools with that token");
if (accessToken) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  const names = [...text.matchAll(/"name":"(\w+)"/g)].map((m) => m[1]);
  if (!names.length) fail(`no tools: ${text.slice(0, 200)}`);
  else pass(`${names.length} tools -> ${names.join(", ")}`);
}

// 11 -------------------------------------------------------------------------
head("Real AJEMS data through the connector");
if (accessToken) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "list_apps_and_forms", arguments: {} },
    }),
  });
  const text = await res.text();
  if (text.includes('"isError":true') || text.includes("Error:")) {
    fail(`AJEMS call failed.\n        ${text.slice(0, 400)}`);
  } else if (text.includes("form_id") || text.includes('"forms"')) {
    pass("AJEMS responded with your workspace");
    const m = text.match(/"form_name":"([^"]+)"/g);
    if (m) console.log(`        forms: ${m.map((x) => x.split('"')[3]).join(", ")}`);
  } else {
    fail(`unexpected: ${text.slice(0, 300)}`);
  }
}

console.log("\n" + "=".repeat(60));
console.log(process.exitCode
  ? "Something failed above — that's where to look."
  : "Everything passed. Your server is working.\nIf Claude still won't connect: delete the connector in Claude and add it again.");

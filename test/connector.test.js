// End to end: Claude's side (a fake client) ⇄ this connector ⇄ the fake AJEMS (mock-ajems.js),
// over real HTTP. Sign-in, the 7-day token, the tools, the confirmation rule, and refusals.
//   npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler).listen(0, () => ok(s)); });
const b64 = (buf) => buf.toString("base64url");

let mock, connector, base, mockBase, oauth, seal, mockMod;
const CB = "http://localhost:5555/callback";      // the "Claude" callback (localhost is allowed for tests)

before(async () => {
  mockMod = await import("../mock-ajems.js");
  mock = await listen(mockMod.mockHandler);
  mockBase = `http://localhost:${mock.address().port}`;
  connector = http.createServer();
  await new Promise((ok) => connector.listen(0, ok));
  base = `http://localhost:${connector.address().port}`;
  Object.assign(process.env, {
    PUBLIC_URL: base, SESSION_KEY: crypto.randomBytes(32).toString("hex"), AJEMS_SERVER_SECRET: "mock-secret-1234567890",
    AJEMS_API_TEMPLATE: `${mockBase}/{org}/api`, AJEMS_WEB_TEMPLATE: `${mockBase}/{org}/web`, ENV_LABEL: "Test",
  });
  const { handler } = await import("../app.js");
  oauth = await import("../oauth.js");
  seal = await import("../seal.js");
  connector.on("request", handler);
});
after(() => { mock.close(); connector.close(); });

const get = (url, headers = {}) => fetch(url, { redirect: "manual", headers });
const post = (url, body, { form = false, headers = {} } = {}) => fetch(url, {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", ...headers },
  body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
});

/** The whole sign-in as Claude and the person would do it. Returns {token, verifier, code}. */
async function signIn(email, { org = "testco" } = {}) {
  const reg = await (await post(`${base}/register`, { client_name: "Claude", redirect_uris: [CB] })).json();
  const verifier = b64(crypto.randomBytes(40));
  const challenge = b64(crypto.createHash("sha256").update(verifier).digest());
  const authUrl = `${base}/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB,
    state: "claude-state", code_challenge: challenge, code_challenge_method: "S256" });
  const pageHtml = await (await get(authUrl)).text();
  const req = /name="req" value="([^"]+)"/.exec(pageHtml)[1];
  const toAjems = await post(`${base}/authorize`, { req, org }, { form: true });
  assert.equal(toAjems.status, 302);
  const connect = new URL(toAjems.headers.get("location"));
  assert.equal(connect.origin + connect.pathname, `${mockBase}/${org}/web/connect`);
  assert.equal(connect.searchParams.get("redirect_uri"), `${base}/oauth/callback`);
  // the person presses Allow on AJEMS's own page (signed in there as `email`)
  const allowed = await post(`${mockBase}/${org}/web/connect/allow`, { ...Object.fromEntries(connect.searchParams), email }, { form: true });
  if (allowed.status !== 302) return { refused: allowed.status, body: await allowed.json() };
  const back = await get(allowed.headers.get("location"));
  if (back.status !== 302) return { failed: back.status, html: await back.text() };
  const toClaude = new URL(back.headers.get("location"));
  assert.equal(toClaude.origin + toClaude.pathname, CB);
  assert.equal(toClaude.searchParams.get("state"), "claude-state");
  const code = toClaude.searchParams.get("code");
  const tok = await post(`${base}/token`, { grant_type: "authorization_code", code, code_verifier: verifier,
                                            redirect_uri: CB, client_id: reg.client_id }, { form: true });
  const body = await tok.json();
  return { status: tok.status, token: body.access_token, body, verifier, code, clientId: reg.client_id };
}

const rpc = async (token, method, params, id = 1) => {
  const res = await post(`${base}/mcp`, { jsonrpc: "2.0", id, method, params }, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, headers: res.headers, body: res.status === 200 ? await res.json() : await res.text() };
};
const call = async (token, name, args) => (await rpc(token, "tools/call", { name, arguments: args })).body.result;

test("discovery documents", async () => {
  const pr = await (await get(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
  const as = await (await get(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.grant_types_supported, ["authorization_code"]);       // no refresh: 7 days, then sign in again
  const health = await (await get(`${base}/health`)).json();
  assert.equal(health.ok, true, JSON.stringify(health.problems));
});

test("full sign-in gives a 7-day token; MCP works as that person", async () => {
  const s = await signIn("staff@testco");
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.ok(s.body.expires_in > 7 * 86400 - 120 && s.body.expires_in <= 7 * 86400);
  assert.equal(s.body.refresh_token, undefined);
  const init = await rpc(s.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.match(init.body.result.instructions, /two steps/);
  const names = (await rpc(s.token, "tools/list")).body.result.tools.map((t) => t.name);
  assert.ok(names.includes("count_records") && names.includes("add_records"));
  assert.ok(!names.includes("create_app"), "staff must not see build tools");
  const count = await call(s.token, "count_records", { form: "Orders" });
  assert.equal(count.structuredContent.count, 2);
});

test("owner sees build tools; staff calling one is refused by AJEMS", async () => {
  const owner = await signIn("owner@testco");
  assert.ok((await rpc(owner.token, "tools/list")).body.result.tools.some((t) => t.name === "create_app"));
  const staff = await signIn("staff@testco");
  const refused = await call(staff.token, "create_app", { app: { name: "X" }, confirmation_id: "x", samples: false });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /owner/);
});

test("a form the person cannot open is an error result, not a crash", async () => {
  const s = await signIn("staff@testco");
  const r = await call(s.token, "count_records", { form: "Salaries" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /among the forms you can open/);
});

test("add_records: preview, confirm once, never twice", async () => {
  const s = await signIn("staff@testco");
  const rows = [{ customer: "Kite", amount: 10 }];
  const preview = await call(s.token, "add_records", { form: "Orders", records: rows });
  const id = preview.structuredContent.confirmation_id;
  assert.ok(id);
  const saved = await call(s.token, "add_records", { form: "Orders", records: rows, confirm: true, confirmation_id: id });
  assert.equal(saved.structuredContent.added, 1);
  const again = await call(s.token, "add_records", { form: "Orders", records: rows, confirm: true, confirmation_id: id });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /already used/);
});

test("a person with Ask AJEN off cannot connect", async () => {
  const s = await signIn("off@testco");
  assert.equal(s.refused, 403);
  assert.match(s.body.error, /administrator/);
});

test("Cancel on the AJEMS page goes back to Claude as access_denied", async () => {
  const reg = await (await post(`${base}/register`, { redirect_uris: [CB] })).json();
  const html = await (await get(`${base}/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id,
    redirect_uri: CB, state: "s1", code_challenge: "x".repeat(43), code_challenge_method: "S256" }))).text();
  const req = /name="req" value="([^"]+)"/.exec(html)[1];
  const step = new URL((await post(`${base}/authorize`, { req, org: "testco" }, { form: true })).headers.get("location"));
  const back = await get(`${base}/oauth/callback?` + new URLSearchParams({ error: "access_denied", state: step.searchParams.get("state") }));
  const to = new URL(back.headers.get("location"));
  assert.equal(to.searchParams.get("error"), "access_denied");
  assert.equal(to.searchParams.get("state"), "s1");
});

test("registration only for Claude / ChatGPT callbacks", async () => {
  for (const bad of ["https://evil.test/cb", "https://claude.ai/api/mcp/auth_callback/../../evil", "javascript:alert(1)"]) {
    assert.equal((await post(`${base}/register`, { redirect_uris: [bad] })).status, 400, bad);
  }
  assert.equal((await post(`${base}/register`, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).status, 201);
  assert.equal((await post(`${base}/register`, { redirect_uris: ["https://chatgpt.com/connector/oauth/abc123"] })).status, 201);
});

test("authorize refuses no PKCE, a forged client and a foreign redirect", async () => {
  const reg = await (await post(`${base}/register`, { redirect_uris: [CB] })).json();
  const q = { response_type: "code", client_id: reg.client_id, redirect_uri: CB, state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256" };
  assert.equal((await get(`${base}/authorize?` + new URLSearchParams({ ...q, code_challenge_method: "plain" }))).status, 400);
  assert.equal((await get(`${base}/authorize?` + new URLSearchParams({ ...q, client_id: "forged" }))).status, 400);
  assert.equal((await get(`${base}/authorize?` + new URLSearchParams({ ...q, redirect_uri: "http://localhost:9999/other" }))).status, 400);
  const html = await (await get(`${base}/authorize?` + new URLSearchParams(q))).text();
  assert.match(html, /never typed here/);
  const req = /name="req" value="([^"]+)"/.exec(html)[1];
  const bad = await post(`${base}/authorize`, { req, org: "evil.com/x" }, { form: true });
  assert.equal(bad.status, 400);                                      // only a subdomain-safe workspace name
});

test("token: wrong verifier, reused code, wrong redirect", async () => {
  const s = await signIn("staff@testco");
  const reuse = await post(`${base}/token`, { grant_type: "authorization_code", code: s.code, code_verifier: s.verifier, redirect_uri: CB }, { form: true });
  assert.equal(reuse.status, 400);                                     // the code was used by signIn already
  const s2 = await signIn("staff@testco");
  assert.equal(s2.status, 200);
  const refresh = await post(`${base}/token`, { grant_type: "refresh_token", refresh_token: "x" }, { form: true });
  assert.equal((await refresh.json()).error, "unsupported_grant_type");
});

test("PKCE: a stolen code is useless without the verifier", async () => {
  // run the flow up to the code, then try to swap it with another verifier
  const reg = await (await post(`${base}/register`, { redirect_uris: [CB] })).json();
  const verifier = b64(crypto.randomBytes(40));
  const challenge = b64(crypto.createHash("sha256").update(verifier).digest());
  const html = await (await get(`${base}/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB,
    state: "s", code_challenge: challenge, code_challenge_method: "S256" }))).text();
  const req = /name="req" value="([^"]+)"/.exec(html)[1];
  const connect = new URL((await post(`${base}/authorize`, { req, org: "testco" }, { form: true })).headers.get("location"));
  const allowed = await post(`${mockBase}/testco/web/connect/allow`, { ...Object.fromEntries(connect.searchParams), email: "staff@testco" }, { form: true });
  const code = new URL((await get(allowed.headers.get("location"))).headers.get("location")).searchParams.get("code");
  const stolen = await post(`${base}/token`, { grant_type: "authorization_code", code, code_verifier: b64(crypto.randomBytes(40)), redirect_uri: CB }, { form: true });
  assert.equal(stolen.status, 400);
  assert.match((await stolen.json()).error_description, /PKCE/);
});

test("MCP without a token, with a forged one, or after AJEMS ends the sign-in → 401 with the sign-in hint", async () => {
  const none = await rpc(null, "tools/list");
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate"), /resource_metadata=".*oauth-protected-resource"/);
  assert.equal((await rpc("forged.token.value", "tools/list")).status, 401);
  // a token sealed with the right key but past its 7 days
  const old = seal.seal("access", { org: "testco", t: "x", x: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await rpc(old, "tools/list")).status, 401);
  // AJEMS itself refuses (its 7 days ended there, or the person was switched off)
  const s = await signIn("staff@testco");
  mockMod.expireAllTokens();
  const ended = await rpc(s.token, "tools/list");
  assert.equal(ended.status, 401);
  assert.match(ended.headers.get("www-authenticate"), /invalid_token/);
});

test("a token sealed for one purpose never opens as another", async () => {
  const s = await signIn("staff@testco");
  assert.equal(seal.unseal("code", s.token), null);
  assert.equal(seal.unseal("client", s.token), null);
  assert.ok(seal.unseal("access", s.token));
});

test("redirect rules", () => {
  assert.equal(oauth.redirectPermitted("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(oauth.redirectPermitted("https://claude.ai/api/mcp/auth_callback?x=1"), false);
  assert.equal(oauth.redirectPermitted("https://claude.ai/api/mcp/%2e%2e/evil"), false);
  assert.equal(oauth.redirectPermitted("https://user:pw@claude.ai/api/mcp/auth_callback"), false);
  assert.equal(oauth.clientOf("https://chatgpt.com/connector/oauth/abc"), "chatgpt");
});

test("unknown JSON-RPC method and notifications", async () => {
  const s = await signIn("staff@testco");
  assert.equal((await rpc(s.token, "resources/list")).body.error.code, -32601);
  const note = await post(`${base}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" }, { headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal(note.status, 202);
  const batch = await post(`${base}/mcp`, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }],
                           { headers: { Authorization: `Bearer ${s.token}` } });
  assert.equal((await batch.json()).length, 2);
});

// ---- registration the way Vercel and ChatGPT do it -------------------------------------
function fakeReq(body, contentType = "application/json") {
  return { headers: { "content-type": contentType }, body, socket: {}, [Symbol.asyncIterator]: async function* () {} };
}
function fakeRes() {
  const out = { status: 0, headers: {}, text: "" };
  return { out, setHeader() {}, writeHead(s, h) { out.status = s; Object.assign(out.headers, h || {}); }, end(t) { out.text = t || ""; } };
}

test("register works when Vercel hands the body over as an object, a string or a Buffer", async () => {
  const body = { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] };
  for (const given of [body, JSON.stringify(body), Buffer.from(JSON.stringify(body))]) {
    const res = fakeRes();
    await oauth.register(fakeReq(given), res);
    assert.equal(res.out.status, 201, `${typeof given} ${res.out.text}`);
    assert.ok(JSON.parse(res.out.text).client_id);
  }
  const res = fakeRes();                                         // no content-type, string body: still read
  await oauth.register(fakeReq(JSON.stringify(body), ""), res);
  assert.equal(res.out.status, 201);
});

test("ChatGPT's exact DCR request (callback-id redirect, asks for client_secret_basic)", async () => {
  const r = await post(`${base}/register`, { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/cb_9f8e7d6c5b"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_basic",
    scope: "ajems" });
  assert.equal(r.status, 201);
  const reg = await r.json();
  assert.equal(reg.token_endpoint_auth_method, "client_secret_basic");
  assert.ok(reg.client_secret);
  const asm = await (await get(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.ok(asm.token_endpoint_auth_methods_supported.includes("client_secret_basic"));
});

test("a refused registration says why", async () => {
  const r = await post(`${base}/register`, { redirect_uris: ["https://evil.test/cb"] });
  assert.match((await r.json()).error_description, /not allowed: https:\/\/evil.test\/cb/);
  const none = await post(`${base}/register`, { client_name: "x" });
  assert.match((await none.json()).error_description, /no redirect_uris/);
});

test("health shows the connector address", async () => {
  const h = await (await get(`${base}/health`)).json();
  assert.equal(h.connector_url, `${base}/mcp`);
});

test("the workspace form may go on to the AJEMS website (Chrome checks the redirect too)", async () => {
  const reg = await (await post(`${base}/register`, { redirect_uris: [CB] })).json();
  const r = await get(`${base}/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB,
    state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256" }));
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, new RegExp(`form-action 'self' ${mockBase.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  assert.match(csp, /frame-ancestors 'none'/);
});

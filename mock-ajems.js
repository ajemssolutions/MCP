// mock-ajems.js — a fake AJEMS for trying the connector with no AJEMS at all, and for the tests.
// It plays both the website (/connect, with an Allow button) and the API (/ajen/mcp/…), for one
// workspace "testco" with three people:
//   owner@testco  — the workspace owner: read, add, build
//   staff@testco  — staff: read and add, no build
//   off@testco    — Ask AJEN switched off: may not connect
//
//   node mock-ajems.js            (port 9090)
//   AJEMS_API_TEMPLATE=http://localhost:9090/{org}/api AJEMS_WEB_TEMPLATE=http://localhost:9090/{org}/web \
//   AJEMS_SERVER_SECRET=mock-secret-1234567890 SESSION_KEY=$(openssl rand -hex 32) npm start

import crypto from "node:crypto";
import http from "node:http";

const SECRET = process.env.MOCK_SECRET || "mock-secret-1234567890";
const PEOPLE = {
  "owner@testco": { id: "1", name: "Olivia Owner", role: "Owner", ajen: true, build: true },
  "staff@testco": { id: "2", name: "Sam Staff", role: "Member", ajen: true, build: false },
  "off@testco": { id: "3", name: "Oscar Off", role: "Member", ajen: false, build: false },
};
const codes = new Map();     // code -> {email, challenge, redirect}
const tokens = new Map();    // token -> {email, exp}
const records = [{ customer: "Apex", amount: 500 }, { customer: "Zen", amount: 900 }];
const confirmations = new Map();

const b64 = (buf) => buf.toString("base64url");
const challengeOf = (v) => b64(crypto.createHash("sha256").update(v).digest());

const READ = { readOnlyHint: true };
const WRITE = { readOnlyHint: false };
const TOOLS = [
  { name: "who_am_i", needs: "read", annotations: READ, description: "Who is signed in", inputSchema: { type: "object", properties: {} } },
  { name: "list_apps_and_forms", needs: "read", annotations: READ, description: "Apps and forms", inputSchema: { type: "object", properties: {} } },
  { name: "count_records", needs: "read", annotations: READ, description: "Count", inputSchema: { type: "object", properties: { form: { type: "string" } }, required: ["form"] } },
  { name: "add_records", needs: "add", annotations: WRITE, description: "Add", inputSchema: { type: "object", properties: { form: { type: "string" }, records: { type: "array" }, confirm: { type: "boolean" }, confirmation_id: { type: "string" } }, required: ["form", "records"] } },
  { name: "create_app", needs: "build", annotations: WRITE, description: "Create app", inputSchema: { type: "object", properties: { app: { type: "object" }, confirmation_id: { type: "string" }, samples: { type: "boolean" } } } },
];

const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const read = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return (req.headers["content-type"] || "").includes("json") ? JSON.parse(text || "{}") : Object.fromEntries(new URLSearchParams(text));
};

function personOf(req) {
  const t = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
  const saved = t && tokens.get(t);
  if (!saved || saved.exp < Date.now() / 1000) return null;
  return { email: saved.email, ...PEOPLE[saved.email] };
}

function runTool(person, name, args) {
  const can = { read: true, add: true, build: person.build };
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) return [404, { error: `No tool called '${name}'.` }];
  if (!can[spec.needs]) return [403, { error: "Only the workspace owner (or a super admin) can build apps and flows." }];
  switch (name) {
    case "who_am_i": return [200, { result: { user: { name: person.name, role: person.role }, can } }];
    case "list_apps_and_forms": return [200, { result: { total_modules: 1, total_forms: 1, total_records: records.length, modules: [{ module: "Sales", forms: [{ form: "Orders", records: records.length }] }] } }];
    case "count_records":
      return args.form === "Orders" ? [200, { result: { form: "Orders", count: records.length } }]
        : [404, { error: `No form called “${args.form}” is among the forms you can open.` }];
    case "add_records": {
      const key = JSON.stringify([person.email, args.form, args.records]);
      if (args.confirm !== true) {
        const id = b64(crypto.randomBytes(12));
        confirmations.set(id, key);
        return [200, { result: { step: "preview", can_add: true, records: args.records.length, confirmation_id: id } }];
      }
      if (confirmations.get(args.confirmation_id) !== key) return [400, { error: "Preview first, and confirm with the confirmation_id that preview returned." }];
      records.push(...args.records);
      return [200, { result: { step: "saved", added: args.records.length } }];
    }
    case "create_app": return [200, { result: { step: "created", app: { title: args.app?.name || "App" } } }];
  }
}

export function mockHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const m = /^\/([a-z0-9-]+)\/(web|api)(\/.*)$/.exec(url.pathname);
  if (!m || m[1] !== "testco") return json(res, 404, { error: "no such workspace" });
  const [, , side, path] = m;
  (async () => {
    // ---- the website: /connect (a person picks who they are, then Allow) ----
    if (side === "web" && path === "/connect" && req.method === "GET") {
      const q = url.searchParams;
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<form method="post" action="/testco/web/connect/allow">${["client", "redirect_uri", "state", "code_challenge", "code_challenge_method"]
        .map((k) => `<input type="hidden" name="${k}" value="${(q.get(k) || "").replace(/"/g, "&quot;")}">`).join("")}
        <select name="email">${Object.keys(PEOPLE).map((e) => `<option>${e}</option>`).join("")}</select><button>Allow</button></form>`);
    }
    if (side === "web" && path === "/connect/allow" && req.method === "POST") {
      const b = await read(req);
      const person = PEOPLE[b.email];
      if (!person) return json(res, 400, { error: "who?" });
      if (!person.ajen) return json(res, 403, { error: "Your administrator has not turned on Ask AJEN for your account." });
      if (b.code_challenge_method !== "S256") return json(res, 400, { error: "PKCE" });
      const code = "c-" + b64(crypto.randomBytes(16));
      codes.set(code, { email: b.email, challenge: b.code_challenge, redirect: b.redirect_uri, t: Date.now() });
      const back = new URL(b.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", b.state);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    // ---- the API ----
    if (path === "/ajen/mcp/token/" && req.method === "POST") {
      if (req.headers["x-ajen-mcp-secret"] !== SECRET) return json(res, 401, { detail: "unauthorized" });
      const b = await read(req);
      const saved = codes.get(b.code);
      codes.delete(b.code);
      if (!saved || saved.redirect !== b.redirect_uri || challengeOf(b.code_verifier || "") !== saved.challenge) return json(res, 401, { detail: "invalid_grant" });
      const token = "ajmcp1.mock-" + b64(crypto.randomBytes(16));
      const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
      tokens.set(token, { email: saved.email, exp });
      return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 7 * 86400, expires_at: exp,
                              user: { id: PEOPLE[saved.email].id, name: PEOPLE[saved.email].name } });
    }
    const person = personOf(req);
    if (path.startsWith("/ajen/mcp/") && !person) return json(res, 401, { detail: "Your AJEMS sign-in for this connector has ended." });
    if (path === "/ajen/mcp/me/" && req.method === "GET") {
      const can = { read: true, add: true, build: person.build };
      return json(res, 200, { user: { name: person.name, role: person.role }, can,
                              tools: TOOLS.filter((t) => can[t.needs]).map(({ needs, ...t }) => t) });
    }
    if (path === "/ajen/mcp/tool/" && req.method === "POST") {
      const b = await read(req);
      const [status, body] = runTool(person, b.name, b.arguments || {});
      return json(res, status, body);
    }
    json(res, 404, { error: "not found" });
  })().catch((e) => json(res, 500, { error: String(e) }));
}

/** Test helper: expire every token (as if 7 days passed on the AJEMS side). */
export const expireAllTokens = () => { for (const t of tokens.values()) t.exp = 0; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT || 9090);
  http.createServer(mockHandler).listen(port, () => console.log(`mock AJEMS on :${port} (workspace testco; secret ${SECRET})`));
}

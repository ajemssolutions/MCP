// diagnose.js — check the whole path on your own machine, as one real person, without Claude:
//   this connector ⇄ your local AJEMS (Django) ⇄ AJEN's permission layer.
//
//   1. In Backend (DEBUG on):   python manage.py ajen_mcp_token <schema> <email>     → prints a token
//   2. Here (same .env as the connector, so SESSION_KEY matches):
//        node diagnose.js http://localhost:8080 <org> <that token>
//
// Run it for the owner and for a staff member: the staff run must show fewer apps / forms and
// no build tools. Nothing is written (only reading tools are called).

import { config } from "./config.js";
import { seal } from "./seal.js";

const [connector = config.publicUrl, org, ajemsToken] = process.argv.slice(2);
if (!org || !ajemsToken) {
  console.log("usage: node diagnose.js <connector url> <org> <token from: python manage.py ajen_mcp_token <schema> <email>>");
  process.exit(2);
}
const base = connector.replace(/\/+$/, "");
const access = seal("access", { org, t: ajemsToken, x: Math.floor(Date.now() / 1000) + 7 * 86400, k: "claude" });
let id = 0;
const rpc = async (method, params) => {
  const res = await fetch(`${base}/mcp`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
const step = async (label, fn) => {
  try { const out = await fn(); console.log(`  ok   ${label}${out ? `  — ${out}` : ""}`); return true; }
  catch (e) { console.log(`  FAIL ${label}  — ${e.message}`); return false; }
};
const text = (r) => r.isError ? `refused: ${r.content[0].text}` : r.structuredContent;

console.log(`AJEMS connector check  ${base}  org=${org}`);
let fine = true;
fine &= await step("health", async () => {
  const h = await (await fetch(`${base}/health`)).json();
  if (!h.ok) throw new Error(h.problems.join("; "));
  return `store=${h.store} api=${h.ajems_api}`;
});
fine &= await step("initialize", async () => (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).serverInfo.version);
let tools = [];
fine &= await step("tools for this person", async () => { tools = (await rpc("tools/list")).tools.map((t) => t.name); return tools.join(", "); });
fine &= await step("who_am_i", async () => {
  const r = text(await rpc("tools/call", { name: "who_am_i", arguments: {} }));
  return typeof r === "string" ? r : `${r.user.name} (${r.user.role}) can=${JSON.stringify(r.can)} until ${r.signed_in_until}`;
});
let first = null;
fine &= await step("list_apps_and_forms", async () => {
  const r = text(await rpc("tools/call", { name: "list_apps_and_forms", arguments: {} }));
  if (typeof r === "string") return r;
  first = r.modules?.find((m) => m.forms?.length);
  return `${r.total_modules} apps, ${r.total_forms} forms, ${r.total_records} records`;
});
if (first) {
  const form = first.forms[0].form;
  fine &= await step(`show_form_fields "${form}"`, async () => {
    const r = text(await rpc("tools/call", { name: "show_form_fields", arguments: { form, module: first.module } }));
    return typeof r === "string" ? r : `${(r.fields || []).length} fields you can read`;
  });
  fine &= await step(`count_records "${form}"`, async () => JSON.stringify(text(await rpc("tools/call", { name: "count_records", arguments: { form, module: first.module } }))).slice(0, 160));
}
fine &= await step("a form that does not exist is refused politely", async () => {
  const r = await rpc("tools/call", { name: "count_records", arguments: { form: "No Such Form 123" } });
  if (!r.isError) throw new Error("expected a refusal");
  return r.content[0].text.slice(0, 90);
});
console.log(fine ? "\nAll checks passed." : "\nSome checks failed (see above).");
process.exit(fine ? 0 : 1);

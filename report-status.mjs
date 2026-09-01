// report-status.mjs — send one report by hand and print exactly what the
// Connector Store says back. Use this to test the Store contract in isolation,
// with no AI client and no MCP server involved.
//
//   node report-status.mjs claude <org> <secret-key>
//   node report-status.mjs chatgpt <org> <secret-key> disconnected
//   node report-status.mjs --from-sessions      # replay every saved session
//
// Nothing here writes to the session store or changes server state.
// The secret key is never printed, only its length.

import "./config.js";   // loads .env from beside this file, not the cwd
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.CONNECTOR_STORE_URL || "https://connectors.ajems.com/api/connectors";
const endpointFor = (ai) => `${BASE.replace(/\/$/, "")}/${ai}/report`;

async function report(ai, org, secretKey, status = "connected") {
  const url = endpointFor(ai);
  console.log(`\nPOST ${url}`);
  console.log(`  org=${org}  status=${status}  secretKey=<${secretKey.length} chars, hidden>`);

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org, secretKey, status }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    console.log(`  -> HTTP ${res.status} in ${Date.now() - started}ms`);
    console.log(`  -> ${text.slice(0, 500) || "(empty body)"}`);
    if (res.status === 401) console.log("  Hint: the Store rejected the org/secretKey pair. Check they match the linked workspace exactly.");
    if (res.status === 404) console.log(`  Hint: no such connector path. Is "${ai}" the id the Store expects?`);
    return res.ok;
  } catch (e) {
    console.log(`  -> failed: ${e.name === "TimeoutError" ? "no response within 10s" : e.message}`);
    return false;
  }
}

const args = process.argv.slice(2);

if (args[0] === "--from-sessions") {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const file = process.env.SESSION_FILE
    ? path.resolve(HERE, process.env.SESSION_FILE)
    : path.join(HERE, "sessions.json");

  if (!fs.existsSync(file)) {
    console.error(`No session file at ${file}. Sign in from an AI client first.`);
    process.exit(1);
  }

  const sessions = Object.values(JSON.parse(fs.readFileSync(file, "utf8")));
  const orgs = new Map();
  for (const s of sessions) if (s?.tenant && s?.secretKey) orgs.set(s.tenant, s.secretKey);

  console.log(`${orgs.size} organisation(s) across ${sessions.length} saved session(s).`);
  for (const [org, key] of orgs) {
    for (const ai of ["claude", "chatgpt"]) await report(ai, org, key);
  }
  process.exit(0);
}

const [ai, org, key, status = "connected"] = args;
if (!ai || !org || !key) {
  console.error("Usage: node report-status.mjs <claude|chatgpt> <org> <secret-key> [connected|disconnected]");
  console.error("   or: node report-status.mjs --from-sessions");
  process.exit(1);
}
process.exit((await report(ai, org, key, status)) ? 0 : 1);

// server.js — run the connector on a normal server (pm2 / systemd) or locally:  npm start
import http from "node:http";
import { config, ENV_FOUND, problems } from "./config.js";
import { handler } from "./app.js";
import { store } from "./store.js";

const missing = problems();
const server = http.createServer(handler);
server.listen(config.port, () => {
  console.log(`AJEMS connector 5.0.3 on :${config.port}  public=${config.publicUrl}/mcp  ${config.envLabel || ""}`);
  console.log(`AJEMS api=${config.apiTemplate}  web=${config.webTemplate}  store=${store.kind}  .env=${ENV_FOUND ? "found" : "not found"}`);
  for (const p of missing) console.warn(`  ! ${p}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));

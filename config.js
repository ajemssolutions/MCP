// config.js — loads .env before anything else reads process.env.
//
// Two traps this avoids:
//
//   1. dotenv resolves .env against the WORKING DIRECTORY by default. pm2,
//      systemd and cron often start a process from somewhere else, so a
//      cwd-relative .env is silently never read and every setting quietly
//      falls back to its default.
//
//   2. ES module imports are evaluated before any statement in the importing
//      file, so calling dotenv.config() inside server.js is already too late
//      for modules imported alongside it. Importing this module first fixes
//      the ordering.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ENV_PATH = path.join(HERE, ".env");
export const ENV_FOUND = fs.existsSync(ENV_PATH);

dotenv.config({ path: ENV_PATH });

/**
 * Read a boolean from the environment without being fussy about it.
 * "true", TRUE, 1, yes, on — with stray quotes or spaces — all count.
 */
export function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = String(raw).trim().toLowerCase().replace(/^["']|["']$/g, "");
  return ["true", "1", "yes", "on"].includes(v);
}

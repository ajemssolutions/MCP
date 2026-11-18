// store.js — the only state this connector keeps: "already used" marks for sign-in codes and
// write confirmations, and sign-in attempt counters. Nothing about people or their data.
// Upstash Redis (REST, no package) when configured — shared by every Vercel instance — else
// memory in this process.

import { config } from "./config.js";

const PREFIX = "ajems-mcp:";

async function redis(command) {
  const res = await fetch(config.redisUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.redisToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`store: ${body.error || res.status}`);
  return body.result;
}

const memory = new Map();   // key -> { n, expires }
const live = (key) => {
  const entry = memory.get(key);
  if (entry && entry.expires <= Date.now()) { memory.delete(key); return null; }
  return entry || null;
};

export const store = config.redisUrl && config.redisToken ? {
  kind: "upstash-redis",
  /** True the first time a key is claimed within `ttl` seconds; false after that. */
  async claim(key, ttl) {
    return (await redis(["SET", PREFIX + key, "1", "NX", "EX", String(Math.ceil(ttl))])) === "OK";
  },
  /** Add one to a counter that expires `ttl` seconds after it starts; the new count. */
  async incr(key, ttl) {
    const n = await redis(["INCR", PREFIX + key]);
    if (n === 1) await redis(["EXPIRE", PREFIX + key, String(Math.ceil(ttl))]);
    return n;
  },
} : {
  kind: process.env.VERCEL ? "memory (per Vercel instance — add Upstash for Redis)" : "memory",
  async claim(key, ttl) {
    if (live(key)) return false;
    memory.set(key, { n: 1, expires: Date.now() + ttl * 1000 });
    return true;
  },
  async incr(key, ttl) {
    const entry = live(key);
    if (entry) { entry.n += 1; return entry.n; }
    memory.set(key, { n: 1, expires: Date.now() + ttl * 1000 });
    return 1;
  },
};

// cache.js — per-tenant TTL cache, in-flight de-duplication, and an outbound
// concurrency limiter.
//
// One user question triggers several tool calls, and each one would otherwise
// re-fetch workspace_config and the full record list. Twenty users asking at
// once meant well over a hundred identical requests to AJEMS.
//
//   TTL cache      — repeat reads within a few seconds are served locally
//   in-flight join — simultaneous identical requests share ONE upstream call
//
// Isolation: keys are namespaced by tenant AND a hash of the secret key, so
// tenants can never read each other's entries and a rotated key self-expires.

import crypto from "node:crypto";

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_UPSTREAM || 12);

const store = new Map();     // key -> { value, expires }
const inflight = new Map();  // key -> Promise

export function tenantNamespace(ctx) {
  const hash = crypto.createHash("sha256").update(ctx.secretKey).digest("hex").slice(0, 12);
  return `${ctx.tenant}:${hash}`;
}

export async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const running = inflight.get(key);
  if (running) return running;

  const promise = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Drop every entry under a prefix. Called after writes so the next read is fresh. */
export function invalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const entry of store.values()) if (entry.expires > now) live++;
  return { entries: store.size, live, inflight: inflight.size };
}

// Evict expired entries so memory stays flat on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) if (entry.expires <= now) store.delete(key);
}, 60_000).unref();

// --- outbound concurrency limiter ------------------------------------------
// Caps simultaneous requests to AJEMS so a busy moment queues rather than
// overwhelming the API.

let active = 0;
const queue = [];

export function withLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

export function limiterStats() {
  return { active, queued: queue.length, max: MAX_CONCURRENT };
}

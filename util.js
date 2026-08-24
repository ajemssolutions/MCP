// util.js — small helpers shared across modules.

/**
 * Work out this server's own public address from the incoming request.
 * Reading it from headers means a change of domain or tunnel needs no config
 * edit; PUBLIC_URL is only the fallback when headers are absent.
 */
export function originOf(req, fallback = "") {
  const host = req.get("x-forwarded-host") || req.get("host");
  if (!host) return fallback.replace(/\/$/, "");
  const local = host.startsWith("localhost") || host.startsWith("127.");
  const proto = req.get("x-forwarded-proto") || (local ? "http" : "https");
  return `${proto}://${host}`;
}

/** MCP tool result helpers. */
export const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
export const fail = (msg) => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });

/** Run tasks with bounded concurrency, preserving input order in the output. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

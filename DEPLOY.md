# Deploying the AJEMS MCP server

One deployment serves every tenant. No per-customer config — users sign in with their organisation name and AJEMS secret key.

---

## What changed from the local version

| Before | Now |
|---|---|
| Tenant + secret key in `.env` | Users type them on the sign-in page |
| One tenant per deployment | Every tenant, one deployment |
| Restart logged everyone out | Sessions saved to `sessions.json` |
| Tunnel URL | Your fixed domain |

`.env` no longer contains any customer credential.

---

## 1. Server requirements

- Node.js 18+
- A domain pointed at the box, e.g. `mcp.ajems.com`
- HTTPS (Claude and ChatGPT refuse plain HTTP)
- Outbound access to `*.buildprohub-server.com`

---

## 2. Configure

```bash
cp .env.example .env
```

```
PORT=8080
PUBLIC_URL=https://mcp.ajems.com
AJEMS_HOST_TEMPLATE=https://{org}.buildprohub-server.com/json_builder
MAX_ROWS=2000
ALLOW_WRITES=false
SESSION_FILE=./sessions.json
```

`{org}` is replaced with whatever the user types at sign-in, after stripping everything except letters, numbers, hyphens and underscores. That sanitising is what stops someone entering `evil.com/x` and pointing your server elsewhere.

Turn `ALLOW_WRITES` on only when you want Claude able to create apps, forms and records.

---

## 3. Run it under a process manager

```bash
npm install --omit=dev
npm install -g pm2
pm2 start server.js --name ajems-mcp
pm2 save
pm2 startup          # run the command it prints
```

`pm2 logs ajems-mcp` shows sign-ins and every tool call.

---

## 4. Nginx + TLS

```nginx
server {
    server_name mcp.ajems.com;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # The server builds OAuth URLs from these. Without them, sign-in breaks.
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host  $host;

        # MCP responses stream — buffering breaks them.
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo certbot --nginx -d mcp.ajems.com
```

`proxy_buffering off` matters. With it on, responses arrive in chunks the client can't parse and tool calls appear to hang.

---

## 5. Verify

```bash
node diagnose.js https://mcp.ajems.com <organisation> <secret-key>
```

Eleven checks covering reachability, both metadata documents, registration, the sign-in page, credential verification, the token exchange, MCP initialize, tools/list, and a live call into that tenant. Run it after every deploy.

Also: `curl https://mcp.ajems.com/health` → `{"ok":true,"mode":"multi-tenant","sessions":N,"writes":false}`

---

## 6. What users do

Give each customer one line:

> Add a custom connector in Claude or ChatGPT pointing at
> **https://mcp.ajems.com/mcp**, then sign in with your organisation name and AJEMS secret key.

### Claude

Settings → Connectors → Add custom connector → paste the URL → Connect → sign in.
All 10 tools available, including writes when `ALLOW_WRITES=true`.

### ChatGPT — two modes, and the difference matters

**With Developer Mode** (Settings → Apps → Advanced settings): every tool works, same as Claude. Requires a paid plan; on Business/Enterprise an admin can disable it org-wide.

**Without Developer Mode**: ChatGPT only calls tools named `search` and `fetch` — it ignores everything else. That's a ChatGPT restriction, not a bug in this server.

So the server ships `search` and `fetch` as wrappers:

- `search("Pune")` scans every form and record, returns matches with ids
- `fetch(id)` returns one record in full, or a form's structure with sample rows

That means **read and search work everywhere**. Creating apps, forms and records needs Developer Mode, because ChatGPT won't call those tools otherwise.

---

## Running for many users at once

Measured with 20 concurrent sessions issuing 60 tool calls: **0.84s total, zero errors, and roughly 22 upstream AJEMS requests instead of ~140.**

**Caching with in-flight joining.** `workspace_config` is cached 60s per tenant, record lists 20s. Simultaneous identical requests share one upstream call rather than each making their own. Any write invalidates that form's cache immediately, so nobody reads stale data after a change.

Cache keys are namespaced by tenant **and** a hash of the secret key, so tenants can never read each other's cached entries, and rotating a key clears its own cache.

**Upstream concurrency cap** (`MAX_CONCURRENT_UPSTREAM=12`) — a traffic spike queues instead of overwhelming the AJEMS API.

**Request timeouts** (`UPSTREAM_TIMEOUT_MS=20000`) — a hung AJEMS call can't hold a slot forever.

**Per-session rate limit** (`RATE_LIMIT_PER_MIN=90`) — a model stuck in a retry loop gets 429s instead of hammering everything.

**Graceful shutdown** — SIGTERM finishes in-flight requests before exiting, so deploys don't drop live calls.

**Memory** stays flat: cache entries expire, rate-limit buckets are swept, expired OAuth codes are cleared, and client registrations are capped.

### Tuning under real traffic

Watch `/health`:

```json
{"sessions":21,"cache":{"entries":3,"live":3,"inflight":0},
 "upstream":{"active":0,"queued":0,"max":12},"memory_mb":191,"uptime_s":300}
```

- `upstream.queued` regularly above 0 → raise `MAX_CONCURRENT_UPSTREAM`, or AJEMS is the bottleneck
- Users complaining about stale data → lower `CONFIG_CACHE_MS` / `ROWS_CACHE_MS`
- `memory_mb` climbing steadily → lower `MAX_ROWS`; each cached form list is held in memory

### Scaling to multiple processes

`pm2 start server.js -i 2` runs two workers. Two caveats before you do:

- The cache is per-process, so upstream requests roughly double
- Sessions are loaded at boot, so a user who signs in on worker A isn't known to worker B until restart

Move sessions to your database before running more than one worker. Single process handles a lot — don't add workers until `/health` shows you need them.

---

## Security notes

**`sessions.json` holds tenant secret keys in plain text.** It's written with `0600` permissions and is gitignored, but it must stay off backups and out of any shared volume. Moving it into your database — with the keys encrypted at rest — is the main hardening step remaining.

**Sign-in is verified live.** Credentials are checked against `workspace_config/` before any token is issued, so a wrong key never produces a working session.

**PKCE is enforced.** A stolen authorization code can't be redeemed without the matching verifier.

**Redirects are validated.** Codes only go to URIs the client registered, so the sign-in page can't be used to deliver a code elsewhere.

**Tenant comes from the session, never from a tool argument.** No tool schema has a `tenant` field, so there is nothing for a model to be persuaded into changing.

**Revoking access:** delete that user's entry from `sessions.json` and restart. Their AJEMS secret key still works everywhere else — only the AI connection dies.

---

## Roadmap

- Sessions in the database, keys encrypted at rest
- Real AJEMS login on the sign-in page instead of pasting a secret key
- Per-user AJEMS permissions, so Claude sees only the forms that user can see
- Token expiry and refresh
- Rate limiting per session

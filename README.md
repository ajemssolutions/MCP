# AJEMS connector for Claude and ChatGPT — v5

Lets Claude and ChatGPT work in an AJEMS workspace **as the person who signed in, with exactly
their AJEMS permissions**. Claude / ChatGPT use their own AI; AJEMS (AJEN's permission code)
decides what they may see and do, on every call.

- **Sign in with AJEMS** — the person types only their workspace name here, then signs in on their
  own AJEMS page (`https://<org>.<web domain>/connect`). The password never reaches this server.
- **7 days, then sign in again** — no refresh token. The token is the person's AJEMS connector
  token, sealed (AES-256-GCM) with `SESSION_KEY`; nothing is stored about anyone.
- **No packages** — plain Node 20+ (no `npm install`). Same code for staging and live.

```
Claude / ChatGPT ──► this connector ──► https://<org>.api…/ajen/mcp/…   (as that person)
                     OAuth + pass-through   │
                                            ├─ Ask AJEN switch for this person (every call)
                                            ├─ apps / forms / rows / fields they may open
                                            ├─ add records: create right, form rules, approval
                                            └─ build apps / flows: owner or super admin only
```

## Files

| File | Role |
|---|---|
| `app.js` | Every address (one request handler) |
| `oauth.js` | OAuth 2.1 + PKCE + client registration; Sign in with AJEMS |
| `mcp.js` | MCP (JSON-RPC over HTTP); passes tool calls to AJEMS; one-use confirmations |
| `ajems.js` | The only module that calls AJEMS |
| `seal.js` | AES-256-GCM sealing with `SESSION_KEY` |
| `store.js` | "Already used" marks and sign-in counters (Upstash Redis, or memory) |
| `config.js` | Settings (`.env` or Vercel Environment Variables) |
| `server.js` / `api/index.js` | Run on a normal server / on Vercel |
| `diagnose.js` | Check the whole path on your machine as one real person |
| `mock-ajems.js` | A fake AJEMS (owner, staff, AJEN-off) for trying it with no AJEMS |
| `test/` | `npm test` — 15 end-to-end checks against the fake AJEMS |

## Tools (they come from AJEMS, per person)

| Who | Tools |
|---|---|
| Everyone with Ask AJEN | `who_am_i`, `list_apps_and_forms`, `show_form_fields`, `count_records`, `summarise_records`, `find_records`, `search_records`, `open_record`, `list_flows` |
| "Create" on the form | `add_records` (preview → confirm) |
| Owner / super admin | `get_build_guide`, `preview_app_design`, `create_app`, `preview_flow`, `save_flow` |
| ChatGPT | `search`, `fetch` |

Writes are always two calls: a preview that returns a `confirmation_id` (signed by AJEMS for
exactly that content, 10 minutes), then the confirmed call. This connector makes each id work once.

## Try it with no AJEMS

```bash
node mock-ajems.js                                   # terminal 1
PUBLIC_URL=http://localhost:8080 SESSION_KEY=$(openssl rand -hex 32) AJEMS_SERVER_SECRET=mock-secret-1234567890 \
AJEMS_API_TEMPLATE='http://localhost:9090/{org}/api' AJEMS_WEB_TEMPLATE='http://localhost:9090/{org}/web' npm start
npm test                                             # the automated checks
```

See `DEPLOY.md` for Vercel (staging and live) and a normal server.
